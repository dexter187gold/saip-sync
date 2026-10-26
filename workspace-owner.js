function resolveWorkspaceKey({ user, tokenUser, workspaces = {} } = {}) {
  // Team members intentionally share the owner's workspace; preserve that link.
  if (user && user.linkedWorkspaceOwnerId) return user.linkedWorkspaceOwnerId

  const id = user?.id || tokenUser?.id
  if (id && Object.prototype.hasOwnProperty.call(workspaces, id)) return id

  // Older installs stored workspaces under the account email instead of user ID.
  // Resolve only against the authenticated user's own email, case-insensitively.
  const emails = [user?.email, tokenUser?.email]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  const keys = Object.keys(workspaces)
  for (const email of emails) {
    const match = keys.find((key) => String(key).trim().toLowerCase() === email)
    if (match) return match
  }

  // New accounts may not have a workspace yet; callers can seed it under user ID.
  return id || null
}

module.exports = { resolveWorkspaceKey }
