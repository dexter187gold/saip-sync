/**
 * Auth recovery helpers — clearer errors + /api/auth/recover
 * Mounted from server optional loop as mountAuthRecover
 */
function mountAuthRecover(app, ctx) {
  const {
    users,
    passwordResets,
    persistUsers,
    persistResets,
    loginRateLimit,
    strongPassword,
    safeEmail,
    now,
    JWT_SECRET,
  } = ctx
  const bcrypt = require('bcryptjs')
  const jwt = require('jsonwebtoken')

  // Only add recover if not already present
  app.post('/api/auth/recover', loginRateLimit || ((_r, _s, n) => n()), (_req, res) => {
    // Recovery codes were previously returned to the requester and are not
    // safe credentials. Keep this legacy route closed until private delivery
    // of high-entropy, single-use reset tokens is implemented.
    res.setHeader('Cache-Control', 'no-store')
    return res.status(503).json({
      error: 'Password recovery is temporarily unavailable. Please contact your workspace administrator for a secure reset.',
    })
  })

  console.log('[auth] recover endpoint ready')
}

module.exports = { mountAuthRecover }
