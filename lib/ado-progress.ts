/**
 * Pure rules for turning Azure DevOps work items into what the portfolio shows.
 *
 * No I/O here so it can be unit-tested with `npm test`. The fetch layer in
 * lib/ado.ts feeds it raw work-item fields.
 *
 * The state bands mirror the tracker's own conventions (a stock Agile process
 * plus tags): New/Proposed is backlog, Active is in progress, Resolved is in
 * review, Closed is done. `blocked` items sit in no band, and `changes-requested`
 * counts as in progress whatever its state. Two deliberate exclusions: Epics
 * (the product itself is not one of its own tasks) and Issues, which hold
 * decisions and ideas rather than work.
 */

export type ProductStage = 'Inbox' | 'Brief' | 'Build' | 'Preview' | 'Deepen' | 'Live' | 'Killed';

export const STAGES: readonly ProductStage[] = ['Inbox', 'Brief', 'Build', 'Preview', 'Deepen', 'Live', 'Killed'];

/** Stages past the design document. The snapshot script defaults to these. */
export const PUBLIC_STAGES: readonly ProductStage[] = ['Build', 'Preview', 'Deepen', 'Live'];

/** What each stage is called on the public page. Internal names stay internal. */
export const STAGE_LABEL: Record<ProductStage, string> = {
  Inbox: 'Idea',
  Brief: 'Planned',
  Build: 'In development',
  Preview: 'Beta',
  Deepen: 'Polishing',
  Live: 'Live',
  Killed: 'Retired',
};

/**
 * The label a visitor sees. The stage tag lags reality: a product can be tagged
 * Brief for weeks after building starts. So a product with work moving or done
 * reads as in development whatever its tag says, until it reaches a later stage.
 */
export function stageLabel(stage: ProductStage, progress: ProductProgress): string {
  if ((stage === 'Inbox' || stage === 'Brief') && progress.inProgress + progress.inReview + progress.done > 0) {
    return STAGE_LABEL.Build;
  }
  return STAGE_LABEL[stage];
}

export type RawItem = {
  id: number;
  type: string;
  state: string;
  tags: string[];
  areaPath: string;
  title: string;
  closedAt: string | null;
};

export type ProductProgress = {
  backlog: number;
  inProgress: number;
  inReview: number;
  done: number;
};

export type Milestone = { id: number; title: string; closedAt: string };

export type ProductSummary = {
  progress: ProductProgress;
  /** Features closed in the window, newest first. */
  recentMilestones: Milestone[];
  /** Features still open: what is planned but not shipped. */
  plannedFeatures: number;
};

const PLATFORM = 'orchestrata';
const PLATFORM_ALIASES = new Set(['company', 'console', PLATFORM]);

export function parseTags(raw: unknown): string[] {
  return String(raw ?? '')
    .split(';')
    .map((t) => t.trim())
    .filter(Boolean);
}

export function tagValue(tags: string[], key: string): string | null {
  const hit = tags.find((t) => t.startsWith(`${key}:`));
  return hit ? hit.slice(key.length + 1) : null;
}

/**
 * Which product an item belongs to: its `product:` tag, else a `console` tag,
 * else the last segment of its area path, with the platform's older names
 * folded into one slug. Same rule the tracker's own dashboard uses.
 */
export function productOf(tags: string[], areaPath: string): string {
  const tagged = tagValue(tags, 'product');
  const raw = tagged ?? (tags.includes('console') ? 'console' : areaPath.split('\\').pop() || PLATFORM);
  return PLATFORM_ALIASES.has(raw.toLowerCase()) ? PLATFORM : raw;
}

export function parseStage(tags: string[]): ProductStage {
  const v = tagValue(tags, 'stage');
  return (STAGES as readonly string[]).includes(v ?? '') ? (v as ProductStage) : 'Inbox';
}

export function parseRank(tags: string[]): number {
  const v = tagValue(tags, 'rank');
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : 99;
}

export function isPublicStage(stage: ProductStage): boolean {
  return PUBLIC_STAGES.includes(stage);
}

type Band = keyof ProductProgress | null;

export function bandOf(item: Pick<RawItem, 'type' | 'state' | 'tags'>): Band {
  if (item.type === 'Epic' || item.type === 'Issue') return null;
  if (item.tags.includes('blocked')) return null;
  if (item.state === 'Removed') return null;
  if (item.tags.includes('changes-requested')) return 'inProgress';
  switch (item.state) {
    case 'New':
    case 'Proposed':
      return 'backlog';
    case 'Active':
      return 'inProgress';
    case 'Resolved':
      return 'inReview';
    case 'Closed':
      return 'done';
    default:
      return 'backlog';
  }
}

/**
 * Feature titles are written for the people running the tracker, not for
 * visitors. Anything that names the process rather than the product stays off
 * the page: standing housekeeping features, anything tagged `internal`, and
 * titles in the tracker's own vocabulary. Retitle in the tracker, or tag it
 * `internal`, to change what shows.
 */
const INTERNAL_TAGS = ['standing', 'ops', 'internal'];
const INTERNAL_TITLE = /\b(agents?|AI|Builder|Reviewer|Critic|Director|sessions?|agent-ready|work queue)\b/i;
// Capitalised on its own: the tracker's name for its owner. Lowercase "board" is a kanban board.
const OWNER_TITLE = /\bBoard\b/;

export function isPublicMilestone(item: Pick<RawItem, 'type' | 'state' | 'tags' | 'title'>): boolean {
  if (item.type !== 'Feature' || item.state === 'Removed') return false;
  if (item.tags.some((t) => INTERNAL_TAGS.includes(t))) return false;
  return !INTERNAL_TITLE.test(item.title) && !OWNER_TITLE.test(item.title);
}

/**
 * Drop tracker asides like "(Board notes, 2026-09-26)" or "(AB#123)", the
 * product's own name as a prefix ("relic-vault - Monetization"), and tidy the
 * spacing.
 */
export function publicTitle(title: string, slug?: string): string {
  let t = title.replace(/\s*\((?:AB#|#|see |Board|Decision|Bug)[^)]*\)/gi, '');
  if (slug) {
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`^${escaped}\\s*[-:–—]\\s*`, 'i'), '');
  }
  return t.replace(/\s{2,}/g, ' ').trim();
}

export function summarize(
  items: RawItem[],
  opts: { now?: number; windowDays?: number; maxMilestones?: number; slug?: string } = {}
): ProductSummary {
  const now = opts.now ?? Date.now();
  const windowMs = (opts.windowDays ?? 30) * 24 * 60 * 60 * 1000;
  const maxMilestones = opts.maxMilestones ?? 5;

  const progress: ProductProgress = { backlog: 0, inProgress: 0, inReview: 0, done: 0 };
  for (const item of items) {
    const band = bandOf(item);
    if (band) progress[band] += 1;
  }

  const features = items.filter(isPublicMilestone);
  const recentMilestones = features
    .filter((f) => f.state === 'Closed' && f.closedAt && now - Date.parse(f.closedAt) <= windowMs)
    .sort((a, b) => Date.parse(b.closedAt!) - Date.parse(a.closedAt!))
    .slice(0, maxMilestones)
    .map((f) => ({ id: f.id, title: publicTitle(f.title, opts.slug), closedAt: f.closedAt! }));

  const plannedFeatures = features.filter((f) => f.state !== 'Closed').length;

  return { progress, recentMilestones, plannedFeatures };
}

/**
 * A display name and one-line pitch from a product epic's title. Newer epics are
 * titled "slug: the pitch"; older ones are just the slug. Either way the name is
 * the slug in title case ("job-hunt" -> "Job Hunt") unless the title supplies
 * something better before the colon.
 */
export function productNameAndPitch(slug: string, title: string): { name: string; pitch: string | null } {
  const fromSlug = slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  const m = /^([^:]+):\s*(.+)$/.exec(title.trim());
  if (!m) return { name: fromSlug, pitch: null };
  const head = m[1].trim();
  const name = head.toLowerCase() === slug.toLowerCase() ? fromSlug : head;
  return { name, pitch: m[2].trim() || null };
}

export function totalOf(p: ProductProgress): number {
  return p.backlog + p.inProgress + p.inReview + p.done;
}
