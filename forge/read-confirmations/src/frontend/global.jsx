import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Text, useProductContext } from '@forge/react';
import { invoke } from '@forge/bridge';

const formatDate = iso =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });

const PageCard = ({ page }) => {
  const complete = page.confirmedCount === page.totalRequired;

  return (
    <>
      <Text>
        {complete ? '✅ ' : '📋 '}
        {page.pageTitle}
        {` — ${page.confirmedCount} / ${page.totalRequired} confirmed`}
        {complete ? ' · Complete' : ''}
      </Text>
      <Text>{`Started: ${formatDate(page.firstConfirmedAt)}`}</Text>

      {page.confirmed.length > 0 && (
        <>
          <Text>Confirmed:</Text>
          {page.confirmed.map(m => (
            <Text key={m.accountId}>{`  ✅ ${m.displayName} · ${formatDate(m.timestamp)}`}</Text>
          ))}
        </>
      )}

      {page.pending.length > 0 && (
        <>
          <Text>Pending:</Text>
          {page.pending.map(m => (
            <Text key={m.accountId}>{`  ⬜ ${m.displayName}`}</Text>
          ))}
        </>
      )}

      <Text> </Text>
    </>
  );
};

const GlobalApp = () => {
  useProductContext();
  const [data, setData] = useState(null);

  useEffect(() => {
    invoke('getAllPages')
      .then(setData)
      .catch(() => setData({ pages: [], error: true }));
  }, []);

  if (!data) return <Text>Loading acknowledgement tracker…</Text>;
  if (data.error) return <Text>⚠️ Could not load tracker data.</Text>;
  if (data.pages.length === 0) {
    return (
      <>
        <Text>📋 Document Acknowledgement Tracker</Text>
        <Text>No confirmations recorded yet. Team members confirm reading by clicking the byline button on a Confluence page.</Text>
      </>
    );
  }

  return (
    <>
      <Text>📋 Document Acknowledgement Tracker</Text>
      <Text>{`${data.pages.length} document${data.pages.length !== 1 ? 's' : ''} tracked`}</Text>
      <Text> </Text>
      {data.pages.map(page => (
        <PageCard key={page.pageId} page={page} />
      ))}
    </>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <GlobalApp />
  </React.StrictMode>
);
