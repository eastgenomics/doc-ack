import Resolver from '@forge/resolver';
import { storage, requestConfluence, requestJira, route } from '@forge/api';

const resolver = new Resolver();

// ─── Storage helpers (Forge storage, keyed by pageId) ────────────────────────

function storageKey(pageId) {
  return `read-confirmations-${pageId}`;
}

async function getConfirmationData(pageId) {
  const data = await storage.get(storageKey(pageId));
  return { readers: data?.readers ?? [] };
}

async function saveConfirmationData(pageId, readers) {
  await storage.set(storageKey(pageId), { readers });
}

async function getDocAckKey(pageId) {
  // Rule A writes this as a Confluence content property via the Jira automation web request
  const res = await requestConfluence(
    route`/rest/api/content/${pageId}/property/docack-parent-key`,
    { headers: { Accept: 'application/json' } }
  );
  if (res.status !== 200) return null;
  const body = await res.json();
  return body.value?.issueKey ?? null;
}

// ─── Jira sub-task helper ─────────────────────────────────────────────────────

async function closeJiraSubtask(pageId, accountId) {
  const parentKey = await getDocAckKey(pageId);
  if (!parentKey) return;

  const jql = encodeURIComponent(
    `project=DOCACK AND parent="${parentKey}" AND assignee="${accountId}" AND status!="Done"`
  );
  const searchRes = await requestJira(
    route`/rest/api/3/search?jql=${jql}&maxResults=1`,
    { headers: { Accept: 'application/json' } }
  );
  const searchBody = await searchRes.json();
  if (!searchBody.issues?.length) return;

  const subtaskId = searchBody.issues[0].id;

  const transRes = await requestJira(
    route`/rest/api/3/issue/${subtaskId}/transitions`,
    { headers: { Accept: 'application/json' } }
  );
  const transBody = await transRes.json();
  const doneTx = transBody.transitions?.find(
    (t) => t.to.statusCategory.key === 'done'
  );
  if (!doneTx) return;

  await requestJira(route`/rest/api/3/issue/${subtaskId}/transitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ transition: { id: doneTx.id } }),
  });
}

// ─── Resolvers ────────────────────────────────────────────────────────────────

resolver.define('getConfirmations', async (req) => {
  const pageId = req.context.extension.content.id;
  const { readers } = await getConfirmationData(pageId);
  return { readers };
});

resolver.define('addConfirmation', async (req) => {
  const pageId = req.context.extension.content.id;
  const accountId = req.context.accountId;

  const { readers } = await getConfirmationData(pageId);

  // Idempotency — do not double-record
  if (readers.find((r) => r.accountId === accountId)) {
    return { readers };
  }

  readers.push({
    accountId,
    displayName: accountId,
    timestamp: new Date().toISOString(),
    version: 'current',
  });

  await saveConfirmationData(pageId, readers);

  // Close Jira sub-task (best-effort)
  try {
    await closeJiraSubtask(pageId, accountId);
  } catch (e) {
    console.error('Failed to close Jira sub-task:', e);
  }

  return { readers };
});

export const handler = resolver.getDefinitions();
