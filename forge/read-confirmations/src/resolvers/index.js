import Resolver from '@forge/resolver';
import { requestConfluence, route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { BINFX_TEAM } from '../constants/binfxTeam.js';

const resolver = new Resolver();

// ─── Storage helpers ──────────────────────────────────────────────────────────

async function getConfirmationData(pageId) {
  const data = await kvs.get(`read-confirmations-${pageId}`);
  return { readers: data?.readers ?? [] };
}

async function saveConfirmationData(pageId, readers) {
  await kvs.set(`read-confirmations-${pageId}`, { readers });
}

// ─── Page index helpers ───────────────────────────────────────────────────────

async function addToPageIndex(pageId, pageTitle) {
  const index = await kvs.get('confirmed-pages-index') ?? [];
  if (!index.find(p => p.pageId === pageId)) {
    index.push({ pageId, pageTitle, firstConfirmedAt: new Date().toISOString() });
    await kvs.set('confirmed-pages-index', index);
  }
}

async function getPageTitle(pageId) {
  try {
    const res = await requestConfluence(
      route`/rest/api/content/${pageId}?fields=title`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return `Page ${pageId}`;
    const body = await res.json();
    return body.title ?? `Page ${pageId}`;
  } catch {
    return `Page ${pageId}`;
  }
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

  // Add page to global index (best-effort, get title from Confluence)
  try {
    const title = await getPageTitle(pageId);
    await addToPageIndex(pageId, title);
  } catch (e) {
    console.error('Failed to update page index:', e);
  }

  return { readers, total: BINFX_TEAM.length };
});

resolver.define('getAllPages', async (_req) => {
  const index = await kvs.get('confirmed-pages-index') ?? [];
  const pages = [];

  for (const entry of index) {
    const { readers } = await getConfirmationData(entry.pageId);
    const confirmedIds = new Set(readers.map(r => r.accountId));

    const confirmed = readers.map(r => ({
      accountId: r.accountId,
      displayName: BINFX_TEAM.find(m => m.accountId === r.accountId)?.name ?? r.accountId,
      timestamp: r.timestamp,
    })).sort((a, b) => a.displayName.localeCompare(b.displayName));

    const pending = BINFX_TEAM
      .filter(m => !confirmedIds.has(m.accountId))
      .map(m => ({ accountId: m.accountId, displayName: m.name }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    pages.push({
      pageId:          entry.pageId,
      pageTitle:       entry.pageTitle,
      firstConfirmedAt: entry.firstConfirmedAt,
      confirmed,
      pending,
      confirmedCount:  confirmed.length,
      totalRequired:   BINFX_TEAM.length,
    });
  }

  // Sort by most recently active first
  pages.sort((a, b) => new Date(b.firstConfirmedAt) - new Date(a.firstConfirmedAt));

  return { pages };
});

export const handler = resolver.getDefinitions();
