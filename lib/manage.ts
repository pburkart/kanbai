import 'server-only';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from './db';
import { verifySession } from './dal';

const SENTINEL = 0;

export type ProjectInput = {
  name: string;
  description: string | null;
  imageUrl: string | null;
  externalUrl: string | null;
  repoUrl: string | null;
  adoSlug: string | null;
  featured: boolean;
  sortOrder: number;
};

export type CardInput = {
  title: string;
  description: string | null;
};

interface OrderRow extends RowDataPacket {
  next: number | null;
}

interface CardPosRow extends RowDataPacket {
  id: number;
  column_id: number;
  order: number;
}

interface CountRow extends RowDataPacket {
  n: number;
}

async function nextOrder(projectId: number, columnId: number): Promise<number> {
  const [rows] = await pool.query<OrderRow[]>(
    'SELECT MAX(`order`) AS next FROM cards WHERE project_id = ? AND column_id = ?',
    [projectId, columnId]
  );
  return (rows[0]?.next ?? 0) + 1;
}

async function assertColumnAllowed(projectId: number, columnId: number): Promise<void> {
  const [rows] = await pool.query<CountRow[]>(
    'SELECT COUNT(*) AS n FROM columns WHERE id = ? AND (project_id = 0 OR project_id = ?)',
    [columnId, projectId]
  );
  if ((rows[0]?.n ?? 0) === 0) throw new Error('Invalid column for this project.');
}

// ---- Projects ----

export async function createProject(input: ProjectInput): Promise<number> {
  await verifySession();
  const [res] = await pool.query<ResultSetHeader>(
    'INSERT INTO projects (name, description, image_url, external_url, repo_url, ado_slug, featured, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      input.name,
      input.description,
      input.imageUrl,
      input.externalUrl,
      input.repoUrl,
      input.adoSlug,
      input.featured ? 1 : 0,
      input.sortOrder,
    ]
  );
  return res.insertId;
}

export async function updateProject(id: number, input: ProjectInput): Promise<void> {
  await verifySession();
  if (id === SENTINEL) throw new Error('Cannot modify the system project.');
  await pool.query(
    'UPDATE projects SET name = ?, description = ?, image_url = ?, external_url = ?, repo_url = ?, ado_slug = ?, featured = ?, sort_order = ? WHERE id = ? AND id != 0',
    [
      input.name,
      input.description,
      input.imageUrl,
      input.externalUrl,
      input.repoUrl,
      input.adoSlug,
      input.featured ? 1 : 0,
      input.sortOrder,
      id,
    ]
  );
}

export type ImportRow = { slug: string; name: string; description: string | null; sortOrder: number };

interface SlugRow extends RowDataPacket {
  ado_slug: string;
}

/**
 * Add a project row per tracker product that is not linked yet. Existing links
 * are left alone, so this is safe to run again; the Board edits copy, image and
 * links afterwards. Returns the slugs that were added.
 */
export async function importProducts(rows: ImportRow[]): Promise<string[]> {
  await verifySession();
  if (rows.length === 0) return [];
  const [linked] = await pool.query<SlugRow[]>(
    'SELECT ado_slug FROM projects WHERE ado_slug IS NOT NULL'
  );
  const have = new Set(linked.map((r) => r.ado_slug));
  const added: string[] = [];
  for (const row of rows) {
    if (have.has(row.slug)) continue;
    await pool.query<ResultSetHeader>(
      'INSERT INTO projects (name, description, image_url, external_url, repo_url, ado_slug, featured, sort_order) VALUES (?, ?, NULL, NULL, NULL, ?, 0, ?)',
      [row.name, row.description, row.slug, row.sortOrder]
    );
    have.add(row.slug);
    added.push(row.slug);
  }
  return added;
}

export async function deleteProject(id: number): Promise<void> {
  await verifySession();
  if (id === SENTINEL) throw new Error('Cannot delete the system project.');
  await pool.query('DELETE FROM projects WHERE id = ? AND id != 0', [id]);
}

// ---- Cards ----

export async function createCard(
  projectId: number,
  columnId: number,
  input: CardInput
): Promise<number> {
  await verifySession();
  if (projectId === SENTINEL) throw new Error('Invalid project.');
  await assertColumnAllowed(projectId, columnId);

  const [res] = await pool.query<ResultSetHeader>(
    'INSERT INTO cards (project_id, column_id, title, description, `order`) VALUES (?, ?, ?, ?, ?)',
    [projectId, columnId, input.title, input.description, await nextOrder(projectId, columnId)]
  );
  return res.insertId;
}

export async function updateCard(
  projectId: number,
  cardId: number,
  input: CardInput
): Promise<void> {
  await verifySession();
  await pool.query('UPDATE cards SET title = ?, description = ? WHERE id = ? AND project_id = ?', [
    input.title,
    input.description,
    cardId,
    projectId,
  ]);
}

export async function deleteCard(projectId: number, cardId: number): Promise<void> {
  await verifySession();
  await pool.query('DELETE FROM cards WHERE id = ? AND project_id = ?', [cardId, projectId]);
}

async function renormalize(projectId: number, columnId: number): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<CardPosRow[]>(
      'SELECT id FROM cards WHERE project_id = ? AND column_id = ? ORDER BY `order` ASC, id ASC',
      [projectId, columnId]
    );
    for (let i = 0; i < rows.length; i++) {
      await conn.query('UPDATE cards SET `order` = ? WHERE id = ?', [i + 1, rows[i].id]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

const MIN_GAP = 1e-4;

export async function repositionCard(
  projectId: number,
  cardId: number,
  toColumnId: number,
  newIndex: number
): Promise<void> {
  await verifySession();
  if (projectId === SENTINEL) throw new Error('Invalid project.');
  await assertColumnAllowed(projectId, toColumnId);

  const [siblings] = await pool.query<CardPosRow[]>(
    'SELECT id, `order` FROM cards WHERE project_id = ? AND column_id = ? AND id != ? ORDER BY `order` ASC, id ASC',
    [projectId, toColumnId, cardId]
  );

  const index = Math.max(0, Math.min(Math.trunc(newIndex), siblings.length));
  const before = index > 0 ? siblings[index - 1].order : null;
  const after = index < siblings.length ? siblings[index].order : null;

  let order: number;
  if (before === null && after === null) order = 1;
  else if (before === null) order = after! - 1;
  else if (after === null) order = before + 1;
  else order = (before + after) / 2;

  const gapTooTight = before !== null && after !== null && Math.abs(after - before) < MIN_GAP;

  const [res] = await pool.query<ResultSetHeader>(
    'UPDATE cards SET column_id = ?, `order` = ? WHERE id = ? AND project_id = ?',
    [toColumnId, order, cardId, projectId]
  );
  if (res.affectedRows === 0) throw new Error('Card not found for this project.');

  if (gapTooTight) await renormalize(projectId, toColumnId);
}
