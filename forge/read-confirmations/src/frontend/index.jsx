import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Text, Button, LoadingButton, useProductContext } from '@forge/react';
import { invoke } from '@forge/bridge';

const App = () => {
  const context = useProductContext();
  const [data, setData] = useState(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (context) {
      invoke('getConfirmations').then(setData);
    }
  }, [context]);

  const confirm = async () => {
    setConfirming(true);
    try {
      const updated = await invoke('addConfirmation');
      setData(updated);
    } finally {
      setConfirming(false);
    }
  };

  if (!data) return <Text>Loading...</Text>;

  const accountId = context?.accountId;
  const alreadyConfirmed = data.readers.find((r) => r.accountId === accountId);
  const count = data.readers.length;

  const confirmedDate = alreadyConfirmed
    ? new Date(alreadyConfirmed.timestamp).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : null;

  return (
    <>
      <Text>
        {alreadyConfirmed
          ? `✅ You confirmed on ${confirmedDate}`
          : `📄 ${count} confirmed`}
      </Text>
      {!alreadyConfirmed && (
        <LoadingButton onClick={confirm} isLoading={confirming}>
          ✅ I have read this document
        </LoadingButton>
      )}
    </>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
