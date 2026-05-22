import { kvs } from '@forge/kvs';
import { fetch } from '@forge/api';

const CONFLUENCE_BASE = 'https://cuhbioinformatics.atlassian.net/wiki';
const JIRA_BASE       = 'https://cuhbioinformatics.atlassian.net';
const DOCACK_PROJECT  = 'DOCACK';
const SUBTASK_TYPE_ID = '10003';

function pageUrlFromId(pageId) {
  return `${CONFLUENCE_BASE}/pages/viewpage.action?pageId=${pageId}`;
}

function extractPageId(url) {
  const match = url?.match(/\/pages\/(\d+)/);
  return match?.[1] ?? null;
}

function jiraHeaders() {
  return {
    'Authorization': 'Basic ' + process.env.JIRA_BASIC_AUTH,
    'Accept':        'application/json',
    'Content-Type':  'application/json',
  };
}

export async function webtriggerHandler(req) {
  console.log('[webtrigger] received request');

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { pageUrl, pageTitle, issueKey } = body ?? {};

    console.log('[webtrigger] pageUrl=' + pageUrl + ' pageTitle=' + pageTitle + ' issueKey=' + issueKey);

    // ── 1. Store page metadata in KVS ────────────────────────────────────
    const pageId = extractPageId(pageUrl);
    if (!pageId) {
      console.error('[webtrigger] could not extract pageId from URL:', pageUrl);
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'no pageId' }) };
    }

    const meta = {
      title:     pageTitle ?? null,
      url:       pageUrl ?? pageUrlFromId(pageId),
      issueKey:  issueKey ?? null,
      updatedAt: new Date().toISOString(),
    };
    await kvs.set('page-meta-' + pageId, meta);
    console.log('[webtrigger] stored page-meta-' + pageId);

    // ── 2. Create sub-tasks from Acknowledgers field ──────────────────────
    if (!issueKey) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, pageId, created: 0 }) };
    }

    // Use acknowledger data passed inline from Automation rule if available
    // (avoids race condition where fields not yet committed at time of fetch)
    const inlineIds   = body.acknowledgerIds;
    const inlineNames = body.acknowledgerNames;
    let acknowledgers = [];

    if (inlineIds && inlineIds.length > 0) {
      // Jira Automation renders multi-user picker as comma-separated strings
      const ids   = String(inlineIds).split(', ').map(s => s.trim()).filter(Boolean);
      const names = inlineNames ? String(inlineNames).split(', ').map(s => s.trim()) : ids;
      acknowledgers = ids.map((id, i) => ({ accountId: id, displayName: names[i] ?? id }));
      console.log('[webtrigger] using inline acknowledgers: ' + acknowledgers.length);
    } else {
      // Fallback: fetch the issue
      const issueRes = await fetch(
        JIRA_BASE + '/rest/api/3/issue/' + issueKey + '?fields=summary,customfield_10651',
        { headers: jiraHeaders() }
      );
      if (!issueRes.ok) {
        const err = await issueRes.text();
        console.error('[webtrigger] failed to fetch issue: ' + issueRes.status + ' ' + err);
        return { statusCode: 200, body: JSON.stringify({ ok: true, pageId, subtaskError: 'could not fetch issue' }) };
      }
      const issue = await issueRes.json();
      acknowledgers = (issue.fields?.customfield_10651 ?? []).map(u => ({ accountId: u.accountId, displayName: u.displayName }));
      console.log('[webtrigger] fetched acknowledgers: ' + acknowledgers.length);
    }

    console.log('[webtrigger] ' + issueKey + ' — ' + acknowledgers.length + ' acknowledger(s)');

    if (acknowledgers.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, pageId, created: 0 }) };
    }

    const results = await Promise.allSettled(
      acknowledgers.map(user => createSubtask(issueKey, summary, user.accountId, user.displayName))
    );

    const created = results.filter(r => r.status === 'fulfilled').length;
    const failed  = results.filter(r => r.status === 'rejected').length;

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error('[webtrigger] sub-task failed for ' + acknowledgers[i]?.displayName + ': ' + r.reason);
      } else {
        console.log('[webtrigger] created sub-task ' + r.value + ' for ' + acknowledgers[i]?.displayName);
      }
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, pageId, created, failed }) };

  } catch (e) {
    console.error('[webtrigger] error: ' + (e?.message ?? e));
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e?.message }) };
  }
}

async function createSubtask(parentKey, parentSummary, accountId, displayName) {
  const res = await fetch(JIRA_BASE + '/rest/api/3/issue', {
    method: 'POST',
    headers: jiraHeaders(),
    body: JSON.stringify({
      fields: {
        project:   { key: DOCACK_PROJECT },
        parent:    { key: parentKey },
        issuetype: { id: SUBTASK_TYPE_ID },
        summary:   'Acknowledge: ' + displayName + ' — ' + parentSummary,
        assignee:  { id: accountId },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('HTTP ' + res.status + ': ' + err);
  }

  const data = await res.json();
  return data.key;
}
