'use strict';

const PHASES = new Set(['queued', 'running', 'choosing-location', 'confirming-location', 'checking', 'backing-up', 'verifying-backup', 'upgrading', 'saving-settings',
  'choosing-file', 'confirming-import', 'archiving', 'parsing', 'importing', 'verifying-archive', 'publishing', 'reading-source',
  'reading-export', 'writing-export', 'completed', 'failed']);
function sanitizeProgress(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['parsedRows','writtenRows','pendingRows','totalRows']) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null;
    result[key] = value[key];
  }
  for (const key of ['copiedBytes','totalBytes']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !/^(?:0|[1-9]\d{0,19})$/.test(value[key])) return null;
    result[key] = value[key];
  }
  if (result.totalRows !== undefined && ['writtenRows','parsedRows','pendingRows'].some(key => result[key] > result.totalRows) ||
      result.pendingRows !== undefined && result.writtenRows !== undefined && result.pendingRows > result.writtenRows ||
      result.copiedBytes !== undefined && result.totalBytes !== undefined && BigInt(result.copiedBytes) > BigInt(result.totalBytes)) return null;
  return Object.keys(result).length ? result : undefined;
}
function sanitizeReceipt(value) {
  if (!value || typeof value !== 'object' || !['completed','failed','cancelled'].includes(value.state)) return undefined;
  const result = { state: value.state };
  for (const key of ['sourceFileId','batchId','totalRows','importedRows','skippedRows','pendingRows','unquantifiableRows','diagnosticRows','errorRows','cancelledRows']) {
    if (value[key] === undefined) continue;
    if (value[key] === null && ['sourceFileId','batchId'].includes(key)) result[key] = null;
    else if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
    else return undefined;
  }
  if (value.errorCode !== undefined) {
    if (typeof value.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value.errorCode)) return undefined;
    result.errorCode = value.errorCode;
  }
  return result;
}

// A wait reminder is informational. It never rejects an accepted operation or
// lets another write pass it while its commit/rollback is still pending.
function createOperationStatus({ operationId, operation, publish, clock = Date.now,
  schedule = setInterval, cancel = clearInterval, waitingAfterMs = 15000 }) {
  const acceptedAt = clock();
  let phase = 'queued', active = true, progress;
  function emit() {
    const elapsedMs = Math.max(0, clock() - acceptedAt);
    try { publish({ operationId, operation, phase, elapsedMs,
      waitingLong: active && elapsedMs >= waitingAfterMs, active, ...(progress ? { progress } : {}) }); }
    catch (_) { /* A closed renderer must not interrupt a database operation. */ }
  }
  const timer = schedule(() => { if (active) emit(); }, 1000);
  timer?.unref?.();
  emit();
  return {
    update(nextPhase, detail) {
      const nextProgress = sanitizeProgress(detail);
      if (!active || nextProgress === null || !PHASES.has(nextPhase) || ['completed', 'failed', 'queued'].includes(nextPhase)) return;
      if (nextPhase === phase && JSON.stringify(progress) === JSON.stringify(nextProgress)) return;
      phase = nextPhase;
      progress = nextProgress;
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

module.exports = { createOperationStatus, PHASES, sanitizeProgress, sanitizeReceipt };
