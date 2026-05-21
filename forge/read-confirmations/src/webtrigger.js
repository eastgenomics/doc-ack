import { kvs } from '@forge/kvs';

const CONFLUENCE_BASE = 'https://cuhbioinformatics.atlassian.net/wiki';

function pageUrlFromId(pageId) {
  return `${CONFLUENCE_BASE}/pages/viewpage.action?pageId=${pageId}`;
}

function extractPageId(url) {
  if (!url) return null;
  const match = url.match(/\/pages\/(\d+)/);
  return match?.[1] ?? null;
}

export async function webtriggerHandler(req) {
  console.log('[webtrigger] received request');

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { pageUrl, pageTitle, issueKey } = body ?? {};

    console.log(`[webtrigger] pageUrl=${pageUrl} pageTitle=${pageTitle} issueKey=${issueKey}`);

    const pageId = extractPageId(pageUrl);
    if (!pageId) {
      console.error('[webtrigger] could not extract pageId from URL:', pageUrl);
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'no pageId' }) };
    }

    const metaKey = `page-meta-${pageId}`;
    const existing = await kvs.get(metaKey);

    const meta = {
      title:     pageTitle ?? existing?.title ?? null,
      url:       pageUrl ?? existing?.url ?? pageUrlFromId(pageId),
      issueKey:  issueKey ?? existing?.issueKey ?? null,
      updatedAt: new Date().toISOString(),
    };

    await kvs.set(metaKey, meta);
    console.log(`[webtrigger] stored page-meta-${pageId}:`, JSON.stringify(meta));

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, pageId }),
    };
  } catch (e) {
    console.error('[webtrigger] error:', e?.message ?? e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e?.message }) };
  }
}
