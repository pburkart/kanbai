import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandOf,
  isPublicMilestone,
  parseRank,
  parseStage,
  parseTags,
  productNameAndPitch,
  productOf,
  publicTitle,
  stageLabel,
  summarize,
  type RawItem,
} from './ado-progress.ts';

test('the public label follows activity when the stage tag lags', () => {
  const idle = { backlog: 3, inProgress: 0, inReview: 0, done: 0 };
  const busy = { backlog: 3, inProgress: 1, inReview: 0, done: 40 };
  assert.equal(stageLabel('Brief', idle), 'Planned');
  assert.equal(stageLabel('Brief', busy), 'In development');
  assert.equal(stageLabel('Inbox', busy), 'In development');
  assert.equal(stageLabel('Build', idle), 'In development');
  assert.equal(stageLabel('Deepen', busy), 'Polishing');
  assert.equal(stageLabel('Live', idle), 'Live');
});

const item = (over: Partial<RawItem>): RawItem => ({
  id: 1,
  type: 'User Story',
  state: 'New',
  tags: [],
  areaPath: 'Orchestrata\\job-hunt',
  title: 'x',
  closedAt: null,
  ...over,
});

test('tags parse from the tracker string form', () => {
  assert.deepEqual(parseTags(' product-epic; stage:Build ;rank:2 '), ['product-epic', 'stage:Build', 'rank:2']);
  assert.equal(parseStage(['stage:Build']), 'Build');
  assert.equal(parseStage(['stage:Nonsense']), 'Inbox');
  assert.equal(parseRank(['rank:7']), 7);
  assert.equal(parseRank([]), 99);
});

test('a product is named by tag, then console tag, then area path, with platform aliases folded', () => {
  assert.equal(productOf(['product:job-hunt'], 'Orchestrata\\other'), 'job-hunt');
  assert.equal(productOf(['console'], 'Orchestrata\\job-hunt'), 'orchestrata');
  assert.equal(productOf([], 'Orchestrata\\relic-vault'), 'relic-vault');
  assert.equal(productOf([], 'Orchestrata\\Company'), 'orchestrata');
  assert.equal(productOf([], 'Orchestrata'), 'orchestrata');
});

test('bands follow state, with tags overriding', () => {
  assert.equal(bandOf(item({ state: 'New' })), 'backlog');
  assert.equal(bandOf(item({ state: 'Proposed' })), 'backlog');
  assert.equal(bandOf(item({ state: 'New', tags: ['agent-ready'] })), 'backlog');
  assert.equal(bandOf(item({ state: 'Active' })), 'inProgress');
  assert.equal(bandOf(item({ state: 'New', tags: ['changes-requested'] })), 'inProgress');
  assert.equal(bandOf(item({ state: 'Resolved' })), 'inReview');
  assert.equal(bandOf(item({ state: 'Resolved', tags: ['qa'] })), 'inReview');
  assert.equal(bandOf(item({ state: 'Closed' })), 'done');
  assert.equal(bandOf(item({ state: 'Active', tags: ['blocked'] })), null);
  assert.equal(bandOf(item({ state: 'Removed' })), null);
  assert.equal(bandOf(item({ type: 'Epic', state: 'Active' })), null);
  assert.equal(bandOf(item({ type: 'Issue', state: 'Closed' })), null);
});

test('summarize counts bands and picks recent shipped features', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const items: RawItem[] = [
    item({ id: 1, state: 'New' }),
    item({ id: 2, state: 'Active' }),
    item({ id: 3, state: 'Resolved' }),
    item({ id: 4, state: 'Closed', closedAt: new Date(now - 2 * day).toISOString() }),
    item({ id: 5, type: 'Bug', state: 'Closed', closedAt: new Date(now - 3 * day).toISOString() }),
    item({ id: 6, type: 'Feature', state: 'Closed', title: 'Old', closedAt: new Date(now - 40 * day).toISOString() }),
    item({ id: 7, type: 'Feature', state: 'Closed', title: 'Recent', closedAt: new Date(now - 5 * day).toISOString() }),
    item({ id: 8, type: 'Feature', state: 'Closed', title: 'Newest', closedAt: new Date(now - 1 * day).toISOString() }),
    item({ id: 9, type: 'Feature', state: 'Closed', title: 'Ops', tags: ['standing', 'ops'], closedAt: new Date(now - 1 * day).toISOString() }),
    item({ id: 10, type: 'Feature', state: 'New', title: 'Planned' }),
    item({ id: 11, type: 'Feature', state: 'Active', title: 'Building' }),
    item({ id: 12, type: 'Feature', state: 'New', title: 'Standing', tags: ['standing'] }),
  ];
  const s = summarize(items, { now });
  assert.deepEqual(s.progress, { backlog: 3, inProgress: 2, inReview: 1, done: 6 });
  assert.deepEqual(
    s.recentMilestones.map((m) => m.title),
    ['Newest', 'Recent']
  );
  assert.equal(s.plannedFeatures, 2);
});

test('milestones in the tracker vocabulary stay internal, and asides are stripped', () => {
  const feature = (title: string, tags: string[] = []) => item({ type: 'Feature', state: 'Closed', title, tags });
  assert.equal(isPublicMilestone(feature('v0.9 Ready for more users')), true);
  assert.equal(isPublicMilestone(feature('console operations: sessions without a story')), false);
  assert.equal(isPublicMilestone(feature("v0.6b The Board's revised answers and AI tailoring")), false);
  assert.equal(isPublicMilestone(feature('Board reports by email')), false);
  assert.equal(isPublicMilestone(feature('A shared kanban board for the household')), true);
  assert.equal(isPublicMilestone(feature('Console v2: steer', ['board-owned', 'console'])), true);
  assert.equal(isPublicMilestone(feature('Company operations', ['standing', 'ops'])), false);
  assert.equal(isPublicMilestone(feature('Anything at all', ['internal'])), false);
  assert.equal(isPublicMilestone(feature('Session recording for players')), false);
  assert.equal(isPublicMilestone(item({ type: 'User Story', state: 'Closed', title: 'A story' })), false);
  assert.equal(publicTitle('Notifications (Board notes, 2026-09-26)'), 'Notifications');
  assert.equal(publicTitle('Playback: stems (AB#3656)'), 'Playback: stems');
  assert.equal(publicTitle('Explore  (see brief) page'), 'Explore page');
  assert.equal(publicTitle('relic-vault - Monetization cycle 1', 'relic-vault'), 'Monetization cycle 1');
  assert.equal(publicTitle('Relic-Vault: streaks', 'relic-vault'), 'streaks');
  assert.equal(publicTitle('Unrelated title', 'relic-vault'), 'Unrelated title');
});

test('a product gets a name and pitch from its epic title', () => {
  assert.deepEqual(productNameAndPitch('job-hunt', 'job-hunt'), { name: 'Job Hunt', pitch: null });
  assert.deepEqual(productNameAndPitch('orchestrata', 'Orchestrata'), { name: 'Orchestrata', pitch: null });
  assert.deepEqual(productNameAndPitch('beatbranch', 'beatbranch: GitHub for music producers - branches'), {
    name: 'Beatbranch',
    pitch: 'GitHub for music producers - branches',
  });
  assert.deepEqual(productNameAndPitch('fleetwork', 'Fleetwork: a community for building software'), {
    name: 'Fleetwork',
    pitch: 'a community for building software',
  });
  assert.deepEqual(productNameAndPitch('par', 'Par, the duel: a 45-second duel'), {
    name: 'Par, the duel',
    pitch: 'a 45-second duel',
  });
});

test('summarize caps the milestone list', () => {
  const now = Date.now();
  const items = Array.from({ length: 8 }, (_, i) =>
    item({ id: i, type: 'Feature', state: 'Closed', title: `F${i}`, closedAt: new Date(now - i * 1000).toISOString() })
  );
  assert.equal(summarize(items, { now, maxMilestones: 3 }).recentMilestones.length, 3);
});
