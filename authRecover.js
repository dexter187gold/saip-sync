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
  app.post('/api/auth/recover', loginRateLimit || ((_r, _s, n) => n()), (req, res) => {
    const emailKey = safeEmail(req.body?.email) || ''
    const recovery_code = String(req.body?.recovery_code || req.body?.code || '').trim()
    const password = req.body?.password || req.body?.newPassword
    if (!emailKey || !recovery_code || !password) {
      return res.status(400).json({ error: 'Email, recovery code, and new password required' })
    }
    const rp = strongPassword(password)
    if (!rp.ok) return res.status(400).json({ error: rp.error })
    const rec = passwordResets['code:' + emailKey + ':' + recovery_code]
    if (!rec || rec.used) {
      return res.status(400).json({ error: 'Invalid or already used recovery code — request a new one via Forgot password' })
    }
    if (new Date(rec.expires) < new Date()) {
      return res.status(400).json({ error: 'Recovery code expired — request a new one' })
    }
    const user = users[rec.email]
    if (!user) return res.status(400).json({ error: 'User no longer exists' })
    user.password_hash = bcrypt.hashSync(password, 10)
    user.updated_at = typeof now === 'function' ? now() : new Date().toISOString()
    rec.used = true
    if (rec.token && passwordResets[rec.token]) passwordResets[rec.token].used = true
    if (typeof persistUsers === 'function') persistUsers()
    if (typeof persistResets === 'function') persistResets()
    const jwtToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '90d' })
    res.json({
      ok: true,
      message: 'Password updated — signed in. Pull cloud profile on the app.',
      token: jwtToken,
      user: { id: user.id, email: user.email, name: user.name },
    })
  })

  console.log('[auth] recover endpoint ready')
}

module.exports = { mountAuthRecover }
