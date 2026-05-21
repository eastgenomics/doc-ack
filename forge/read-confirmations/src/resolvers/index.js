import Resolver from '@forge/resolver';
import { kvs } from '@forge/kvs';
import { BINFX_TEAM } from '../constants/binfxTeam.js';

const resolver = new Resolver();

// ─── Storage helpers ──────────────────────────────────────────────────────────

function storageKey(pageId) {
  return `read-confirmations-${pageId}`;
}

async function getConfirmationData(pageId) {
  const data = await kvs.get(storageKey(pageId));
  return { readers: data?.readers ?? [] };
}

async function saveConfirmationData(pageId, readers) {
  await kvs.set(storageKey(pageId), { readers });
}

const CONFLUENCE_BASE = 'https://cuhbioinformatics.atlassian.net/wiki';

function pageUrlFromId(pageId) {
  return `${CONFLUENCE_BASE}/pages/viewpage.action?pageId=${pageId}`;
}

// ─── Resolvers ────────────────────────────────────────────────────────────────

resolver.define('getConfirmations', async (req) => {
  const pageId = req.context.extension.content.id;
  const { readers } = await getConfirmationData(pageId);
  return { readers, total: BINFX_TEAM.length };
});

resolver.define('addConfirmation', async (req) => {
  const pageId    = req.context.extension.content.id;
  const accountId = req.context.accountId;

  const { readers } = await getConfirmationData(pageId);

  if (readers.find((r) => r.accountId === accountId)) {
    return { readers, total: BINFX_TEAM.length };
  }

  readers.push({ accountId, timestamp: new Date().toISOString() });
  await saveConfirmationData(pageId, readers);

  return { readers, total: BINFX_TEAM.length };
});

resolver.define('getAllPages', async (_req) => {
  let results = [];
  let cursor;
  do {
    const q = kvs.query().where('key', { condition: 'BEGINS_WITH', values: ['read-confirmations-'] });
    if (cursor) q.cursor(cursor);
    const page = await q.limit(50).getMany();
    results = results.concat(page.results ?? []);
    cursor = page.nextCursor;
  } while (cursor);

  const pages = [];
  for (const item of results) {
    const pageId = item.key.replace('read-confirmations-', '');
    const readers = item.value?.readers ?? [];
    if (readers.length === 0) continue;

    const confirmedIds = new Set(readers.map(r => r.accountId));

    const confirmed = readers
      .map(r => ({
        accountId:   r.accountId,
        displayName: BINFX_TEAM.find(m => m.accountId === r.accountId)?.name ?? r.accountId,
        timestamp:   r.timestamp,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    const pending = BINFX_TEAM
      .filter(m => !confirmedIds.has(m.accountId))
      .map(m => ({ accountId: m.accountId, displayName: m.name }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    const firstConfirmedAt = readers.map(r => r.timestamp).sort()[0] ?? new Date().toISOString();

    pages.push({
      pageId,
      pageUrl:        pageUrlFromId(pageId),
      firstConfirmedAt,
      confirmed,
      pending,
      confirmedCount: confirmed.length,
      totalRequired:  BINFX_TEAM.length,
    });
  }

  pages.sort((a, b) => new Date(b.firstConfirmedAt) - new Date(a.firstConfirmedAt));
  return { pages };
});

export const handler = resolver.getDefinitions();
