import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Text, Button, Textfield, useProductContext } from '@forge/react';
import { invoke } from '@forge/bridge';

const AdminApp = () => {
  const context = useProductContext();
  const [cycle, setCycle] = useState(undefined); // undefined = loading
  const [taskKeyInput, setTaskKeyInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (context) {
      invoke('getCycleStatus')
        .then(res => setCycle(res.cycle ?? null))
        .catch(() => setCycle(null));
    }
  }, [context]);

  const start = async (force = false) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await invoke('startAcknowledgementCycle', {
        taskKey: taskKeyInput.trim().toUpperCase(),
        force,
      });
      if (res.error) {
        setError(res.detail ?? res.error);
      } else {
        setCycle({ status: 'pending_request', taskKey: res.taskKey });
      }
    } catch (err) {
      setError(err.message ?? 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (cycle === undefined) return <Text>Loading...</Text>;

  // ── Cycle complete ───────────────────────────────────────────────────────────
  if (cycle?.status === 'complete') {
    const confirmed = cycle.members?.length ?? 0;
    const date = cycle.completedAt ? new Date(cycle.completedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    return (
      <>
        <Text>{`✅ All ${confirmed} team members confirmed on ${date}`}</Text>
        <Text>{`Task: ${cycle.taskKey}`}</Text>
        <Button onClick={() => { setCycle(null); setTaskKeyInput(''); }}>Start New Cycle</Button>
      </>
    );
  }

  // ── Cycle active ─────────────────────────────────────────────────────────────
  if (cycle?.status === 'active') {
    const total     = cycle.members?.length ?? '?';
    const pending   = cycle.pendingAccountIds?.length ?? '?';
    const confirmed = typeof total === 'number' && typeof pending === 'number' ? total - pending : '?';
    return (
      <>
        <Text>{`📋 Acknowledgement cycle active — ${confirmed} / ${total} confirmed`}</Text>
        <Text>{`Task: ${cycle.taskKey} · Sub-tasks update every ~20 min`}</Text>
        <Button onClick={() => start(true)}>Restart cycle (creates new sub-tasks)</Button>
      </>
    );
  }

  // ── Cycle failed ─────────────────────────────────────────────────────────────
  if (cycle?.status === 'failed') {
    return (
      <>
        <Text>{`❌ Cycle setup failed for ${cycle.taskKey}`}</Text>
        <Text>{cycle.failureReason ?? 'Unknown error. Check Forge logs.'}</Text>
        <Button onClick={() => { setCycle(null); setTaskKeyInput(cycle.taskKey ?? ''); }}>Retry</Button>
      </>
    );
  }

  // ── Pending (queued, not yet processed by scheduler) ─────────────────────────
  if (cycle?.status === 'pending_request') {
    return (
      <>
        <Text>{`⏳ Cycle queued for ${cycle.taskKey}`}</Text>
        <Text>Sub-tasks will be created within the next scheduler run (up to 20 min).</Text>
      </>
    );
  }

  // ── No cycle / idle — show form ───────────────────────────────────────────────
  return (
    <>
      <Text>Enter the DOCACK task key to start an acknowledgement cycle.</Text>
      <Textfield
        placeholder="e.g. DOCACK-7"
        value={taskKeyInput}
        onChange={e => { setTaskKeyInput(e.target.value); setError(null); }}
      />
      {error && <Text>{`⚠️ ${error}`}</Text>}
      <Button
        onClick={() => start(false)}
        isDisabled={submitting || !taskKeyInput.trim()}
      >
        {submitting ? 'Starting…' : '▶ Start Acknowledgement Cycle'}
      </Button>
    </>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <AdminApp />
  </React.StrictMode>
);
