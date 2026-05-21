import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Text, LoadingButton, useProductContext } from '@forge/react';
import { invoke } from '@forge/bridge';

const App = () => {
  const context = useProductContext();
  const [data, setData] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  useEffect(() => {
    if (context) {
      invoke('getConfirmations')
        .then(setData)
        .catch(() => setData({ readers: [], total: 25, error: true }));
    }
  }, [context]);

  const confirm = async () => {
    setConfirming(true);
    setErrorMsg(null);
    try {
      const updated = await invoke('addConfirmation');
      if (updated?.readers) setData(updated);
      else setErrorMsg('Could not save. Please try again.');
    } catch {
      setErrorMsg('Confirmation failed. Please try again.');
    } finally {
      setConfirming(false);
    }
  };

  if (!data) return <Text>Loading...</Text>;
  if (data.error) return <Text>⚠️ Could not load. Please refresh.</Text>;

  const accountId       = context?.accountId;
  const alreadyConfirmed = data.readers.find(r => r.accountId === accountId);
  const count           = data.readers.length;
  const total           = data.total ?? 25;

  const confirmedDate = alreadyConfirmed
    ? new Date(alreadyConfirmed.timestamp).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
    : null;

  return (
    <>
      <Text>{`📄 ${count} / ${total} confirmed`}</Text>
      {alreadyConfirmed
        ? <Text>{`✅ You confirmed on ${confirmedDate}`}</Text>
        : <LoadingButton onClick={confirm} isLoading={confirming}>
            ✅ I have read this document
          </LoadingButton>
      }
      {errorMsg && <Text>⚠️ {errorMsg}</Text>}
    </>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
