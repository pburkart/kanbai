'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { verifyCredentials } from '@/lib/admin';
import { clientIp, createSession, destroySession } from '@/lib/session';
import { applyGlobalDelay, checkLock, clearFailures, recordFailure } from '@/lib/login-throttle';
import {
  createCard,
  createProject,
  deleteCard,
  deleteProject,
  importProducts,
  repositionCard,
  updateCard,
  updateProject,
} from '@/lib/manage';
import { getProducts } from '@/lib/ado';
import { productNameAndPitch } from '@/lib/ado-progress';

export type LoginState = { error: string | null };

/**
 * Only relative paths under /manage are accepted, so a crafted
 * `?next=https://evil.example` can't turn login into an open redirect.
 */
function safeNext(raw: FormDataEntryValue | null): string {
  const value = typeof raw === 'string' ? raw : '';
  if (!value.startsWith('/manage')) return '/manage';
  // Reject protocol-relative (`//host`) and any escape sequences.
  if (value.startsWith('//') || value.includes('\\')) return '/manage';
  return value;
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const ip = await clientIp();

  const lock = await checkLock(ip);
  if (lock.locked) {
    return { error: `Too many attempts. Try again in ${lock.retryAfterSec}s.` };
  }

  await applyGlobalDelay();

  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');
  const next = safeNext(formData.get('next'));

  const ok = username !== '' && password !== '' && (await verifyCredentials(username, password));

  if (!ok) {
    await recordFailure(ip);
    // Deliberately generic — never reveal which field was wrong.
    return { error: 'Invalid credentials.' };
  }

  await clearFailures(ip);
  await createSession(username);

  // redirect() signals via a thrown control-flow error, so it must stay
  // outside any try/catch in this function.
  redirect(next);
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect('/manage/login');
}

// ============================================================
// Content management
//
// Authorization lives in lib/manage.ts — every mutation there calls
// verifySession() itself, so these wrappers only parse and validate.
// ============================================================

export type FormState = { error: string | null };

class Invalid extends Error {}

function required(fd: FormData, name: string, label: string, max: number): string {
  const value = String(fd.get(name) ?? '').trim();
  if (!value) throw new Invalid(`${label} is required.`);
  if (value.length > max) throw new Invalid(`${label} must be ${max} characters or fewer.`);
  return value;
}

function optional(fd: FormData, name: string, label: string, max: number): string | null {
  const value = String(fd.get(name) ?? '').trim();
  if (!value) return null;
  if (value.length > max) throw new Invalid(`${label} must be ${max} characters or fewer.`);
  return value;
}

/**
 * Only http(s) is accepted. These values are rendered into `href`/`src` on the
 * public site, so permitting arbitrary schemes here would turn the admin form
 * into a stored-XSS vector via `javascript:`.
 */
function optionalUrl(fd: FormData, name: string, label: string): string | null {
  const value = optional(fd, name, label, 500);
  if (value === null) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Invalid(`${label} must be a full URL beginning with http:// or https://`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Invalid(`${label} must use http:// or https://`);
  }
  return parsed.toString();
}

function id(fd: FormData, name: string, label: string): number {
  const value = Number(fd.get(name));
  if (!Number.isInteger(value) || value <= 0) throw new Invalid(`${label} is invalid.`);
  return value;
}

function refresh(projectId?: number) {
  revalidatePath('/');
  revalidatePath('/manage');
  if (projectId) {
    revalidatePath(`/manage/projects/${projectId}`);
    revalidatePath(`/projects/${projectId}`);
  }
}

function message(err: unknown): string {
  if (err instanceof Invalid) return err.message;
  console.error('[manage] mutation failed:', err);
  // Never surface raw driver errors to the client.
  return 'Something went wrong. Please try again.';
}

/** A tracker product slug: what follows `product:` on its epic. Lowercase, digits and hyphens only. */
function optionalSlug(fd: FormData, name: string, label: string): string | null {
  const value = optional(fd, name, label, 64);
  if (value === null) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Invalid(`${label} must be a slug: lowercase letters, digits and hyphens.`);
  }
  return value;
}

function smallInt(fd: FormData, name: string, label: string): number {
  const raw = String(fd.get(name) ?? '').trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || Math.abs(n) > 9999) throw new Invalid(`${label} must be a whole number.`);
  return n;
}

function projectFields(fd: FormData) {
  return {
    name: required(fd, 'name', 'Name', 255),
    description: optional(fd, 'description', 'Description', 5000),
    imageUrl: optionalUrl(fd, 'imageUrl', 'Image URL'),
    externalUrl: optionalUrl(fd, 'externalUrl', 'Project URL'),
    repoUrl: optionalUrl(fd, 'repoUrl', 'Repository URL'),
    adoSlug: optionalSlug(fd, 'adoSlug', 'Tracker product'),
    featured: fd.get('featured') === 'on',
    sortOrder: smallInt(fd, 'sortOrder', 'Sort order'),
  };
}

export async function createProjectAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    await createProject(projectFields(fd));
  } catch (err) {
    return { error: message(err) };
  }
  refresh();
  return { error: null };
}

export async function updateProjectAction(_prev: FormState, fd: FormData): Promise<FormState> {
  let projectId: number;
  try {
    projectId = id(fd, 'projectId', 'Project');
    await updateProject(projectId, projectFields(fd));
  } catch (err) {
    return { error: message(err) };
  }
  refresh(projectId);
  return { error: null };
}

/**
 * Add the ticked tracker products as project rows, named from their epics. The
 * slugs come from checkboxes; the names and pitches are looked up server-side,
 * so nothing in the form can name a product the tracker does not have.
 */
export async function importProductsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const wanted = new Set(
      fd
        .getAll('slug')
        .map((v) => String(v).trim())
        .filter((v) => /^[a-z0-9][a-z0-9-]*$/.test(v))
    );
    if (wanted.size === 0) throw new Invalid('Tick at least one product.');
    const products = await getProducts();
    const rows = products
      .filter((p) => wanted.has(p.slug))
      .map((p) => {
        const { name, pitch } = productNameAndPitch(p.slug, p.title);
        return { slug: p.slug, name, description: pitch, sortOrder: p.rank * 10 };
      });
    const added = await importProducts(rows);
    if (added.length === 0) throw new Invalid('Those products are already on the board.');
  } catch (err) {
    return { error: message(err) };
  }
  refresh();
  return { error: null };
}

export async function deleteProjectAction(fd: FormData): Promise<void> {
  await deleteProject(id(fd, 'projectId', 'Project'));
  refresh();
  redirect('/manage');
}

export async function createCardAction(_prev: FormState, fd: FormData): Promise<FormState> {
  let projectId: number;
  try {
    projectId = id(fd, 'projectId', 'Project');
    await createCard(projectId, id(fd, 'columnId', 'Column'), {
      title: required(fd, 'title', 'Title', 255),
      description: optional(fd, 'description', 'Description', 5000),
    });
  } catch (err) {
    return { error: message(err) };
  }
  refresh(projectId);
  return { error: null };
}

export async function updateCardAction(_prev: FormState, fd: FormData): Promise<FormState> {
  let projectId: number;
  try {
    projectId = id(fd, 'projectId', 'Project');
    await updateCard(projectId, id(fd, 'cardId', 'Card'), {
      title: required(fd, 'title', 'Title', 255),
      description: optional(fd, 'description', 'Description', 5000),
    });
  } catch (err) {
    return { error: message(err) };
  }
  refresh(projectId);
  return { error: null };
}

export async function deleteCardAction(fd: FormData): Promise<void> {
  const projectId = id(fd, 'projectId', 'Project');
  await deleteCard(projectId, id(fd, 'cardId', 'Card'));
  refresh(projectId);
}

/**
 * Called directly from the drag-and-drop board rather than through a form, so
 * it takes plain arguments. Still fully validated: these values arrive from the
 * client and are no more trustworthy than form fields.
 */
export async function repositionCardAction(
  projectId: number,
  cardId: number,
  toColumnId: number,
  newIndex: number
): Promise<FormState> {
  try {
    for (const [value, label] of [
      [projectId, 'Project'],
      [cardId, 'Card'],
      [toColumnId, 'Column'],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) throw new Invalid(`${label} is invalid.`);
    }
    if (!Number.isInteger(newIndex) || newIndex < 0) throw new Invalid('Position is invalid.');

    await repositionCard(projectId, cardId, toColumnId, newIndex);
  } catch (err) {
    return { error: message(err) };
  }
  refresh(projectId);
  return { error: null };
}
