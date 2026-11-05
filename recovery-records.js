/**
 * Consume every credential issued by the same password-recovery request.
 * A request creates both a high-entropy token record and a code lookup record;
 * either credential must invalidate the other after a successful reset.
 */
function consumeRecoveryRecords(passwordResets, selectedRecord) {
  if (!passwordResets || !selectedRecord) return
  const email = String(selectedRecord.email || '').toLowerCase()
  const token = String(selectedRecord.token || '')
  for (const [key, record] of Object.entries(passwordResets)) {
    if (record === selectedRecord ||
        (email && String(record?.email || '').toLowerCase() === email &&
          token && (key === token || String(record?.token || '') === token))) {
      record.used = true
    }
  }
}

module.exports = { consumeRecoveryRecords }
