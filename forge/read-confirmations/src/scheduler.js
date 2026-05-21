import { requestJira, route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { BINFX_TEAM } from './constants/binfxTeam.js';

// ─── Custom field IDs (DOCACK project) ───────────────────────────────────────
const FIELD_ACK_REQUIRED = 'customfield_10650';
const FIELD_ACKNOWLEDGERS = 'customfield_10651';
const FIELD_DOC_URL       = 'customfield_10718';
const FIELD_DOC_VERSION   = 'customfield_10649';
const BINFX_GROUP_ID      = '1759f2a0-cdea-4dc6-81d1-0df1e34ca510';

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function handler(event, context) {
  console.log('[docack-trigger] Run start:', new Date().toISOString());
  try {
    await processPendingCreates();
    await processActiveTransitions();
  } catch (err) {
    // Do NOT re-throw — thrown errors pause the Forge trigger schedule
    console.error('[docack-trigger] Unhandled error:', err);
  }
  console.log('[docack-trigger] Run complete:', new Date().toISOString());
}

// ─── Step 1: Discover work ───────────────────────────────────────────────────

async function processPendingCreates() {
  const pendingIndex = await kvs.get('docack-pending-creates') ?? [];
  console.log(`[docack-trigger] Pending creates: ${pendingIndex.length}`);
  for (const pageId of pendingIndex) {
    await handlePendingCreate(pageId);
  }
}

async function processActiveTransitions() {
  const activeIndex = await kvs.get('docack-active-cycles') ?? [];
  console.log(`[docack-trigger] Active cycles: ${activeIndex.length}`);
  for (const pageId of activeIndex) {
    await handleActiveTransitions(pageId);
  }
}

// ─── Step 2: Create sub-tasks for pending cycle requests ─────────────────────

async function handlePendingCreate(pageId) {
  const request = await kvs.get(`docack-cycle-request-${pageId}`);
  if (!request) {
    await removeFromIndex('docack-pending-creates', pageId);
    return;
  }

  const { taskKey, force } = request;
  console.log(`[docack-trigger] Processing create for page ${pageId} / ${taskKey}`);

  // Guard: don't double-create an active cycle
  const existingCycle = await kvs.get(`docack-cycle-${pageId}`);
  if (existingCycle?.status === 'active' && !force) {
    console.warn(`[docack-trigger] Skipping: cycle already active for page ${pageId}`);
    await kvs.delete(`docack-cycle-request-${pageId}`);
    await removeFromIndex('docack-pending-creates', pageId);
    return;
  }

  // Fetch DOCACK task from Jira
  let task;
  try {
    task = await fetchDocackTaskByKey(taskKey);
  } catch (err) {
    console.error(`[docack-trigger] fetchDocackTaskByKey failed for ${taskKey}:`, err.message);
    await incrementRequestRetryCount(pageId, taskKey, err.message);
    return;
  }

  // Resolve member list
  let members;
  try {
    if (task.acknowledgementRequired === 'Yes - whole team') {
      members = await fetchGroupMembers();
    } else if (task.acknowledgementRequired === 'Yes - specified individuals') {
      members = task.acknowledgers;
      if (!members.length) {
        console.error(`[docack-trigger] No acknowledgers on ${taskKey}`);
        await cleanupRequest(pageId);
        return;
      }
    } else {
      console.log(`[docack-trigger] ${taskKey} does not require acknowledgement`);
      await cleanupRequest(pageId);
      return;
    }
  } catch (err) {
    console.error(`[docack-trigger] fetchGroupMembers failed:`, err.message);
    await incrementRequestRetryCount(pageId, taskKey, err.message);
    return;
  }

  // Create sub-tasks in parallel (requestJira works here — scheduler asApp() context)
  const { subTaskMap, createErrors } = await createSubtasksWithKeys(
    taskKey, members, task.summary, task.docUrl, task.docVersion
  );

  const now = new Date().toISOString();
  const pendingAccountIds = members
    .filter(m => subTaskMap[m.accountId])
    .map(m => m.accountId);

  await kvs.set(`docack-cycle-${pageId}`, {
    taskKey,
    taskSummary: task.summary,
    docVersion:  task.docVersion,
    docUrl:      task.docUrl,
    startedAt:   now,
    completedAt: null,
    status:      'active',
    subTaskMap,
    pendingAccountIds,
    members: members.map(m => ({ accountId: m.accountId, displayName: m.displayName ?? m.accountId })),
    createErrors,
    transitionErrors: [],
    retryCount: 0,
    lastProcessedAt: now,
  });

  // Update indices
  const activeIndex = await kvs.get('docack-active-cycles') ?? [];
  if (!activeIndex.includes(pageId)) {
    activeIndex.push(pageId);
    await kvs.set('docack-active-cycles', activeIndex);
  }
  await kvs.delete(`docack-cycle-request-${pageId}`);
  await removeFromIndex('docack-pending-creates', pageId);

  console.log(`[docack-trigger] Created ${Object.keys(subTaskMap).length} sub-tasks for ${taskKey} (${createErrors.length} errors)`);
}

// ─── Step 3: Transition confirmed sub-tasks ───────────────────────────────────

async function handleActiveTransitions(pageId) {
  const cycle = await kvs.get(`docack-cycle-${pageId}`);
  if (!cycle || cycle.status !== 'active') {
    await removeFromIndex('docack-active-cycles', pageId);
    return;
  }

  const data = await kvs.get(`read-confirmations-${pageId}`) ?? { readers: [] };
  const confirmedIds = new Set(data.readers.map(r => r.accountId));

  // Accounts to transition: newly confirmed + previous errors now confirmed
  const toTransition = [
    ...cycle.pendingAccountIds.filter(id => confirmedIds.has(id)),
    ...cycle.transitionErrors.filter(e => confirmedIds.has(e.accountId)).map(e => e.accountId),
  ];
  const uniqueToTransition = [...new Set(toTransition)];

  if (uniqueToTransition.length === 0) {
    await kvs.set(`docack-cycle-${pageId}`, { ...cycle, lastProcessedAt: new Date().toISOString() });
    return;
  }

  // Resolve Done transition ID from a sample sub-task
  const sampleKey = Object.values(cycle.subTaskMap)[0];
  const doneTransitionId = sampleKey ? await resolveDoneTransitionId(sampleKey) : null;
  if (!doneTransitionId) {
    console.error(`[docack-trigger] Cannot resolve Done transition for page ${pageId}`);
    return;
  }

  const remainingPending = [...cycle.pendingAccountIds];
  const newTransitionErrors = [];

  for (const accountId of uniqueToTransition) {
    const subTaskKey = cycle.subTaskMap[accountId];
    if (!subTaskKey) continue;
    const ok = await transitionIssue(subTaskKey, doneTransitionId);
    if (ok) {
      const i = remainingPending.indexOf(accountId);
      if (i !== -1) remainingPending.splice(i, 1);
    } else {
      newTransitionErrors.push({
        accountId,
        subTaskKey,
        error: 'transition POST failed',
        attemptedAt: new Date().toISOString(),
      });
    }
  }

  // Step 4: Complete cycle if all pending cleared
  let status = 'active';
  let completedAt = null;

  if (remainingPending.length === 0 && newTransitionErrors.length === 0) {
    const parentDone = await transitionParentToDone(cycle.taskKey);
    if (parentDone) {
      status = 'complete';
      completedAt = new Date().toISOString();
      await removeFromIndex('docack-active-cycles', pageId);
      console.log(`[docack-trigger] Cycle complete for page ${pageId} / ${cycle.taskKey}`);
    }
    // else stay active and retry next run
  }

  await kvs.set(`docack-cycle-${pageId}`, {
    ...cycle,
    pendingAccountIds: remainingPending,
    transitionErrors: newTransitionErrors,
    status,
    completedAt,
    retryCount: cycle.retryCount + (newTransitionErrors.length > 0 ? 1 : 0),
    lastProcessedAt: new Date().toISOString(),
  });
}

// ─── Jira API helpers (scheduler context — requestJira works as asApp()) ─────

async function fetchDocackTaskByKey(key) {
  const res = await requestJira(
    route`/rest/api/3/issue/${key}?fields=summary,${FIELD_ACK_REQUIRED},${FIELD_ACKNOWLEDGERS},${FIELD_DOC_URL},${FIELD_DOC_VERSION}`,
    { headers: { Accept: 'application/json' } }
  );
  console.log(`[docack-trigger] fetchDocackTaskByKey ${key} → HTTP ${res.status}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // Also test a DI issue for comparison
    const testRes = await requestJira(route`/rest/api/3/issue/DI-3266?fields=summary`, { headers: { Accept: 'application/json' } });
    console.log(`[docack-trigger] DI-3266 test → HTTP ${testRes.status}`);
    throw new Error(`fetchDocackTaskByKey HTTP ${res.status}: ${JSON.stringify(err.errorMessages ?? err)}`);
  }
  const issue = await res.json();
  return {
    key:  issue.key,
    summary: issue.fields.summary,
    acknowledgementRequired: issue.fields[FIELD_ACK_REQUIRED]?.value ?? null,
    acknowledgers: issue.fields[FIELD_ACKNOWLEDGERS] ?? [],
    docUrl:    issue.fields[FIELD_DOC_URL] ?? null,
    docVersion: issue.fields[FIELD_DOC_VERSION] ?? null,
  };
}

async function fetchGroupMembers() {
  let members = [], startAt = 0, isLast = false;
  while (!isLast) {
    const res = await requestJira(
      route`/rest/api/3/group/member?groupId=${BINFX_GROUP_ID}&maxResults=50&startAt=${startAt}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) throw new Error(`fetchGroupMembers HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.values)) throw new Error('fetchGroupMembers: unexpected response shape');
    members = members.concat(body.values);
    isLast = body.isLast;
    startAt += body.values.length;
    if (body.values.length === 0) break;
  }
  return members;
}

async function createSubtasksWithKeys(parentKey, members, taskSummary, docUrl, docVersion) {
  const results = await Promise.allSettled(
    members.map(async (member) => {
      const res = await requestJira(route`/rest/api/3/issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          fields: {
            project:   { key: 'DOCACK' },
            issuetype: { name: 'Sub-task' },
            parent:    { key: parentKey },
            summary:   `Read & Acknowledge: ${taskSummary}`,
            assignee:  { accountId: member.accountId },
            labels:    ['acknowledgement-task'],
            [FIELD_DOC_URL]:     docUrl,
            [FIELD_DOC_VERSION]: docVersion,
          },
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(`HTTP ${res.status}: ${JSON.stringify(errBody.errors ?? errBody)}`);
      }
      const body = await res.json();
      return { accountId: member.accountId, subTaskKey: body.key }; // capture key, not id
    })
  );

  const subTaskMap = {};
  const createErrors = [];
  results.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      subTaskMap[result.value.accountId] = result.value.subTaskKey;
    } else {
      createErrors.push({
        accountId: members[idx]?.accountId ?? 'unknown',
        error: result.reason?.message ?? String(result.reason),
        attemptedAt: new Date().toISOString(),
      });
    }
  });
  return { subTaskMap, createErrors };
}

async function resolveDoneTransitionId(issueKey) {
  const res = await requestJira(
    route`/rest/api/3/issue/${issueKey}/transitions`,
    { headers: { Accept: 'application/json' } }
  );
  if (!res.ok) return null;
  const body = await res.json();
  return body.transitions?.find(t => t.to?.statusCategory?.key === 'done')?.id ?? null;
}

async function transitionIssue(issueKey, transitionId) {
  const res = await requestJira(route`/rest/api/3/issue/${issueKey}/transitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ transition: { id: transitionId } }),
  });
  // 204 No Content on success — do NOT call res.json()
  if (res.status < 200 || res.status > 299) {
    console.error(`[docack-trigger] transitionIssue ${issueKey} failed: HTTP ${res.status}`);
    return false;
  }
  return true;
}

async function transitionParentToDone(taskKey) {
  const doneId = await resolveDoneTransitionId(taskKey);
  if (!doneId) return false;
  return transitionIssue(taskKey, doneId);
}

// ─── Index helpers ────────────────────────────────────────────────────────────

async function removeFromIndex(indexKey, pageId) {
  const index = await kvs.get(indexKey) ?? [];
  await kvs.set(indexKey, index.filter(id => id !== pageId));
}

async function cleanupRequest(pageId) {
  await kvs.delete(`docack-cycle-request-${pageId}`);
  await removeFromIndex('docack-pending-creates', pageId);
}

async function incrementRequestRetryCount(pageId, taskKey, errorMessage) {
  const request = await kvs.get(`docack-cycle-request-${pageId}`);
  if (!request) return;
  const retryCount = (request.retryCount ?? 0) + 1;
  if (retryCount >= 5) {
    console.error(`[docack-trigger] Abandoning create for page ${pageId} after 5 attempts`);
    await kvs.set(`docack-cycle-${pageId}`, {
      taskKey,
      status: 'failed',
      failureReason: `Create failed after 5 attempts: ${errorMessage}`,
      startedAt: request.requestedAt,
      lastProcessedAt: new Date().toISOString(),
    });
    await cleanupRequest(pageId);
  } else {
    await kvs.set(`docack-cycle-request-${pageId}`, {
      ...request,
      retryCount,
      lastError: errorMessage,
      lastAttemptAt: new Date().toISOString(),
    });
  }
}
