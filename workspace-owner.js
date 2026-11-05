function hasWorkspaceData(row) {
  const data = row && row.data && typeof row.data === 'object' ? row.data : row
  if (!data || typeof data !== 'object') return false
  if (data.company && (Array.isArray(data.company) ? data.company.length > 0 : typeof data.company === 'object')) return true
  return ['clients', 'invoices', 'quotes', 'tickets', 'payments', 'products', 'services', 'expenses']
    .some((key) => Array.isArray(data[key]) && data[key].length > 0)
}

function isReadOnlyTeamMember(user) {
  return Boolean(user?.linkedWorkspaceOwnerId && String(user.teamRole || '').toLowerCase() === 'viewer')
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

module.exports = { resolveWorkspaceKey, isReadOnlyTeamMember }

const TEAM_DATA_KEYS = Object.freeze({
  admin: ['clients', 'invoices', 'quotes', 'tickets', 'payments', 'products', 'services', 'expenses', 'company', 'inventory', 'jobs', 'documents', 'employees', 'payslips', 'purchaseOrders', 'estimates', 'workOrders', 'assets', 'recurringInvoices', 'taxes', 'bankTransactions', 'cashbook', 'pettyCash', 'categories', 'templates', 'notes', 'reminders', 'supportTickets', 'communications', 'branding'],
  manager: ['clients', 'invoices', 'quotes', 'tickets', 'payments', 'products', 'services', 'expenses', 'company', 'inventory', 'jobs', 'documents', 'employees', 'payslips', 'purchaseOrders', 'estimates', 'workOrders', 'assets', 'recurringInvoices', 'taxes', 'bankTransactions', 'cashbook', 'pettyCash', 'categories', 'templates', 'notes', 'reminders', 'supportTickets', 'communications', 'branding'],
  front_desk: ['clients', 'invoices', 'quotes', 'payments', 'tickets', 'company'],
  helpdesk: ['clients', 'tickets', 'supportTickets', 'company'],
  tech: ['clients', 'tickets', 'products', 'services', 'jobs', 'workOrders', 'assets', 'company'],
  accountant: ['clients', 'invoices', 'quotes', 'payments', 'expenses', 'products', 'services', 'purchaseOrders', 'taxes', 'bankTransactions', 'cashbook', 'pettyCash', 'company'],
  viewer: ['clients', 'invoices', 'quotes', 'tickets', 'payments', 'products', 'services', 'expenses', 'company', 'inventory', 'jobs', 'documents', 'employees', 'payslips', 'purchaseOrders', 'estimates', 'workOrders', 'assets', 'recurringInvoices', 'taxes', 'bankTransactions', 'cashbook', 'pettyCash', 'categories', 'templates', 'notes', 'reminders', 'supportTickets', 'communications', 'branding'],
})

function isTeamMember(user) {
  return Boolean(user?.linkedWorkspaceOwnerId)
}

function filterTeamWorkspaceData(data, role) {
  const allowed = TEAM_DATA_KEYS[String(role || '').toLowerCase()] || []
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const filtered = {}
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(source, key)) filtered[key] = source[key]
  }
  return filtered
}

function mergeTeamWorkspaceData(currentData, incomingData, role) {
  const current = currentData && typeof currentData === 'object' && !Array.isArray(currentData) ? currentData : {}
  const incoming = incomingData && typeof incomingData === 'object' && !Array.isArray(incomingData) ? incomingData : {}
  const normalizedRole = String(role || '').toLowerCase()
  // Enforce viewer read-only semantics in the data layer as well as the route.
  if (normalizedRole === 'viewer') return current
  const allowed = new Set(TEAM_DATA_KEYS[normalizedRole] || [])
  const merged = { ...current }
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) merged[key] = incoming[key]
  }
  return merged
}

module.exports.isTeamMember = isTeamMember
module.exports.filterTeamWorkspaceData = filterTeamWorkspaceData
module.exports.mergeTeamWorkspaceData = mergeTeamWorkspaceData
