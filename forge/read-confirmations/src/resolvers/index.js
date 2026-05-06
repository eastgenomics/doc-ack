import Resolver from '@forge/resolver';
import { requestConfluence, requestJira, route } from '@forge/api';

const resolver = new Resolver();

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getConfirmationData(pageId) {
  const res = await requestConfluence(
    route`/rest/api/content/${pageId}/property/read-confirmations`,
    { headers: { Accept: 'application/json' } }
  );
  if (res.status === 404) return { readers: [], version: 0 };
  const body = await res.json();
  return { readers: body.value.readers || [], version: body.version.number };
}

async function saveConfirmationData(pageId, readers, currentVersion) {
  const isNew = currentVersion === 0;
  const method = isNew ? 'POST' : 'PUT';
  const url = isNew
    ? route`/rest/api/content/${pageId}/property`
    : route`/rest/api/content/${pageId}/property/read-confirmations`;

  const res = await requestConfluence(url, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      key: 'read-confirmations',
      value: { readers },
      ...(isNew ? {} : { version: { number: currentVersion + 1 } }),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to save confirmations (${res.status}): ${body}`);
  }
}

async function closeJiraSubtask(pageId, accountId) {
  // 1. Get the DOCACK parent issue key from the page's content property
  const keyRes = await requestConfluence(
    route`/rest/api/content/${pageId}/property/docack-parent-key`,
    { headers: { Accept: 'application/json' } }
  );
  if (keyRes.status !== 200) return;

  const keyBody = await keyRes.json();
  const parentKey = keyBody.value.issueKey;

  // 2. Find the user's open sub-task under that parent
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

  // 3. Get the Done transition ID
  const transRes = await requestJira(
    route`/rest/api/3/issue/${subtaskId}/transitions`,
    { headers: { Accept: 'application/json' } }
  );
  const transBody = await transRes.json();
  const doneTx = transBody.transitions?.find(
    (t) => t.to.statusCategory.key === 'done'
  );
  if (!doneTx) return;

  // 4. Transition to Done
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
  const displayName = req.context.accountId; // accountId used as fallback; display name resolved client-side

  const { readers, version } = await getConfirmationData(pageId);

  // Idempotency — do not double-record
  if (readers.find((r) => r.accountId === accountId)) {
    return { readers };
  }

  readers.push({
    accountId,
    displayName,
    timestamp: new Date().toISOString(),
    version: 'current',
  });

  await saveConfirmationData(pageId, readers, version);

  // Close Jira sub-task (best-effort)
  try {
    await closeJiraSubtask(pageId, accountId);
  } catch (e) {
    console.error('Failed to close Jira sub-task:', e);
  }

  return { readers };
});

export const handler = resolver.getDefinitions();
