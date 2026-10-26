function hasWorkspaceData(row) {
  const data = row && row.data && typeof row.data === 'object' ? row.data : row
  if (!data || typeof data !== 'object') return false
  if (data.company && (Array.isArray(data.company) ? data.company.length > 0 : typeof data.company === 'object')) return true
  return ['clients', 'invoices', 'quotes', 'tickets', 'payments', 'products', 'services', 'expenses']
    .some((key) => Array.isArray(data[key]) && data[key].length > 0)
}

function resolveWorkspaceKey({ user, tokenUser, workspaces = {} } = {}) {
  // Team members intentionally share the owner's workspace; preserve that link.
  if (user && user.linkedWorkspaceOwnerId) return user.linkedWorkspaceOwnerId

  const id = user?.id || tokenUser?.id
  const idRow = id ? workspaces[id] : null
  const emails = [user?.email, tokenUser?.email]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  const keys = Object.keys(workspaces)
  let emailKey = null
  for (const email of emails) {
    emailKey = keys.find((key) => String(key).trim().toLowerCase() === email) || null
    if (emailKey) break
  }

  // Some legacy accounts have both an empty ID-keyed workspace (seeded during
  // account creation) and the real profile keyed by email. Prefer the populated
  // legacy profile over an empty shell; otherwise prefer the canonical user ID.
  if (idRow && emailKey && emailKey !== id &&
      !hasWorkspaceData(idRow) && hasWorkspaceData(workspaces[emailKey])) return emailKey
  if (idRow) return id
  if (emailKey) return emailKey

  // New accounts may not have a workspace yet; callers can seed it under user ID.
  return id || null
}

module.exports = { resolveWorkspaceKey }
