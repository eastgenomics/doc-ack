import { fetch } from '@forge/api';

const JIRA_BASE = 'https://cuhbioinformatics.atlassian.net';
const DOCACK_PROJECT = 'DOCACK';
const SUBTASK_ISSUETYPE_ID = '10003';

function jiraHeaders() {
  const auth = process.env.JIRA_BASIC_AUTH;
  return {
    'Authorization': 'Basic ' + auth,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
}

export async function jiraWebtriggerHandler(req) {
  console.log('[jira-webtrigger] received request');

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { issueKey } = body ?? {};

    if (!issueKey) {
      console.error('[jira-webtrigger] missing issueKey');
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'missing issueKey' }) };
    }

    console.log('[jira-webtrigger] fetching issue ' + issueKey);

    // Fetch the DOCACK issue to get Acknowledgers field
    const issueRes = await fetch(
      JIRA_BASE + '/rest/api/3/issue/' + issueKey + '?fields=summary,customfield_10651',
      { headers: jiraHeaders() }
    );

    if (!issueRes.ok) {
      const err = await issueRes.text();
      console.error('[jira-webtrigger] failed to fetch issue ' + issueKey + ': ' + issueRes.status + ' ' + err);
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'failed to fetch issue' }) };
    }

    const issue = await issueRes.json();
    const summary = issue.fields?.summary ?? issueKey;
    const acknowledgers = issue.fields?.customfield_10651 ?? [];

    console.log('[jira-webtrigger] ' + issueKey + ' "' + summary + '" — ' + acknowledgers.length + ' acknowledger(s)');

    if (acknowledgers.length === 0) {
      console.log('[jira-webtrigger] no acknowledgers set, skipping sub-task creation');
      return { statusCode: 200, body: JSON.stringify({ ok: true, created: 0 }) };
    }

    // Create one sub-task per acknowledger in parallel
    const results = await Promise.allSettled(
      acknowledgers.map(user => createSubtask(issueKey, summary, user.accountId, user.displayName))
    );

    const created = results.filter(r => r.status === 'fulfilled').length;
    const failed  = results.filter(r => r.status === 'rejected').length;

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error('[jira-webtrigger] sub-task failed for ' + acknowledgers[i]?.displayName + ': ' + r.reason);
      } else {
        console.log('[jira-webtrigger] created sub-task ' + r.value + ' for ' + acknowledgers[i]?.displayName);
      }
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, created, failed }) };

  } catch (e) {
    console.error('[jira-webtrigger] error: ' + (e?.message ?? e));
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
        issuetype: { id: SUBTASK_ISSUETYPE_ID },
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
