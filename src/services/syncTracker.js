const pendingSyncKeys = new Set();

export function markPendingSync(fileKey) {
  pendingSyncKeys.add(fileKey);
}

export function clearPendingSync(fileKey) {
  pendingSyncKeys.delete(fileKey);
}

export function isPendingSync(fileKey) {
  return pendingSyncKeys.has(fileKey);
}

export default { markPendingSync, clearPendingSync, isPendingSync };
