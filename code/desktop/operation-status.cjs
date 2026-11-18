'use strict';

const PHASES = new Set(['queued', 'running', 'choosing-location', 'confirming-location', 'checking', 'backing-up', 'verifying-backup', 'upgrading', 'saving-settings', 'completed', 'failed']);

// A wait reminder is informational. It never rejects an accepted operation or
// lets another write pass it while its commit/rollback is still pending.
function createOperationStatus({ operationId, operation, publish, clock = Date.now,
  schedule = setInterval, cancel = clearInterval, waitingAfterMs = 15000 }) {
  const acceptedAt = clock();
  let phase = 'queued', active = true;
  function emit() {
    const elapsedMs = Math.max(0, clock() - acceptedAt);
    try { publish({ operationId, operation, phase, elapsedMs,
      waitingLong: active && elapsedMs >= waitingAfterMs, active }); }
    catch (_) { /* A closed renderer must not interrupt a database operation. */ }
  }
  const timer = schedule(() => { if (active) emit(); }, 1000);
  timer?.unref?.();
  emit();
  return {
    update(nextPhase) {
      if (!active || nextPhase === phase || !PHASES.has(nextPhase) || ['completed', 'failed', 'queued'].includes(nextPhase)) return;
      phase = nextPhase;
      emit();
    },
    finish(ok) {
      if (!active) return;
      active = false;
      phase = ok ? 'completed' : 'failed';
      cancel(timer);
      emit();
    }
  };
}

module.exports = { createOperationStatus };
