/**
 * Git-backed durability for saip-sync data/*.json
 * Survives Render free-tier disk wipes.
 *
 * Env:
 *   GIT_DATA_ENABLED=true
 *   GIT_DATA_REPO=https://github.com/YOU/saip-sync-data.git
 *   GIT_DATA_TOKEN=github_pat_...
 *   GIT_DATA_BRANCH=main
 *   GIT_PUSH_DEBOUNCE_MS=15000
 */
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const GIT_ENABLED =
  String(process.env.GIT_DATA_ENABLED || '').toLowerCase() === 'true' ||
  !!(process.env.GIT_DATA_REPO && process.env.GIT_DATA_TOKEN)
const GIT_REPO = process.env.GIT_DATA_REPO || ''
const GIT_BRANCH = process.env.GIT_DATA_BRANCH || 'main'
const GIT_TOKEN = String(process.env.GIT_DATA_TOKEN || '')
  .trim()
  .replace(/^['"]|['"]$/g, '')
const GIT_USER = process.env.GIT_DATA_USER || 'saip-sync-bot'
const GIT_EMAIL = process.env.GIT_DATA_EMAIL || 'saip-sync@users.noreply.github.com'
const GIT_PUSH_DEBOUNCE_MS = Number(process.env.GIT_PUSH_DEBOUNCE_MS) || 15000

const meta = {
  enabled: GIT_ENABLED,
  lastPullAt: null,
  lastPushAt: null,
  lastError: null,
  lastCommit: null,
  pulls: 0,
  pushes: 0,
}

function authedGitUrl(repoUrl) {
  if (!GIT_TOKEN || !repoUrl) return repoUrl
  // Fine-grained + classic PATs: https://x-access-token:TOKEN@github.com/...
  const encoded = encodeURIComponent(GIT_TOKEN)
  try {
    const u = new URL(repoUrl.replace(/\.git$/, '') + '.git')
    u.username = 'x-access-token'
    u.password = GIT_TOKEN
    return u.toString()
  } catch {
    const bare = String(repoUrl).replace(/^https?:\/\//, '').replace(/\.git$/, '')
    return `https://x-access-token:${encoded}@${bare}.git`
  }
}

function createGitStore(DATA_DIR) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  let pushTimer = null
  let pushInFlight = false

  function runGit(args, opts = {}) {
    return execFileAsync('git', args, {
      cwd: opts.cwd || DATA_DIR,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: opts.timeout || 90000,
      maxBuffer: 15 * 1024 * 1024,
    })
  }

  async function initOrPull() {
    if (!GIT_ENABLED || !GIT_REPO) {
      console.log('[git] disabled — set GIT_DATA_REPO + GIT_DATA_TOKEN')
      return { ok: false, reason: 'disabled' }
    }
    const remote = authedGitUrl(GIT_REPO)
    const gitDir = path.join(DATA_DIR, '.git')
    try {
      if (!fs.existsSync(gitDir)) {
        const tmp = path.join(path.dirname(DATA_DIR), '.git-data-tmp')
        try {
          fs.rmSync(tmp, { recursive: true, force: true })
        } catch {}
        console.log('[git] cloning data repo…')
        try {
          await execFileAsync(
            'git',
            ['clone', '--depth', '1', '--branch', GIT_BRANCH, remote, tmp],
            {
              env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
              timeout: 120000,
              maxBuffer: 20 * 1024 * 1024,
            }
          )
        } catch (e) {
          console.warn('[git] clone failed, init empty', (e.stderr || e.message || '').toString().slice(0, 200))
          await runGit(['init', '-b', GIT_BRANCH])
          await runGit(['config', 'user.name', GIT_USER])
          await runGit(['config', 'user.email', GIT_EMAIL])
          try {
            await runGit(['remote', 'add', 'origin', remote])
          } catch {}
          meta.lastError = 'clone failed — will push on first save'
          return { ok: false, error: 'clone_failed' }
        }
        for (const name of fs.readdirSync(tmp)) {
          if (name === '.git') continue
          try {
            fs.cpSync(path.join(tmp, name), path.join(DATA_DIR, name), { recursive: true, force: true })
          } catch (e) {
            console.warn('[git] copy', name, e.message)
          }
        }
        try {
          fs.rmSync(gitDir, { recursive: true, force: true })
          fs.renameSync(path.join(tmp, '.git'), gitDir)
        } catch {
          try {
            fs.cpSync(path.join(tmp, '.git'), gitDir, { recursive: true })
          } catch {}
        }
        try {
          fs.rmSync(tmp, { recursive: true, force: true })
        } catch {}
      } else {
        try {
          await runGit(['remote', 'set-url', 'origin', remote])
        } catch {
          try {
            await runGit(['remote', 'add', 'origin', remote])
          } catch {}
        }
        await runGit(['fetch', 'origin', GIT_BRANCH]).catch(() => {})
        try {
          await runGit(['reset', '--hard', `origin/${GIT_BRANCH}`])
        } catch (e) {
          console.warn('[git] reset', (e.message || '').slice(0, 120))
        }
      }
      try {
        await runGit(['config', 'user.name', GIT_USER])
        await runGit(['config', 'user.email', GIT_EMAIL])
      } catch {}
      let head = null
      try {
        head = (await runGit(['rev-parse', '--short', 'HEAD'])).stdout.trim()
      } catch {}
      meta.lastPullAt = new Date().toISOString()
      meta.lastCommit = head
      meta.lastError = null
      meta.pulls++
      console.log('[git] ready · head', head || '(empty)')
      return { ok: true, head }
    } catch (e) {
      const msg = (e.stderr?.toString?.() || e.message || String(e)).slice(0, 400)
      console.error('[git] init/pull', msg)
      meta.lastError = msg
      return { ok: false, error: msg }
    }
  }

  async function commitAndPush(reason = 'save') {
    if (!GIT_ENABLED || !GIT_REPO) return { ok: false, reason: 'disabled' }
    if (pushInFlight) return { ok: false, reason: 'busy' }
    pushInFlight = true
    const remote = authedGitUrl(GIT_REPO)
    try {
      try {
        await runGit(['config', 'user.name', GIT_USER])
        await runGit(['config', 'user.email', GIT_EMAIL])
      } catch {}
      try {
        await runGit(['remote', 'set-url', 'origin', remote])
      } catch {
        try {
          await runGit(['remote', 'add', 'origin', remote])
        } catch {}
      }
      await runGit(['add', 'users.json', 'workspaces.json', 'password_resets.json']).catch(() => {})
      await runGit(['add', '-A', '*.json']).catch(() => {})
      let status = ''
      try {
        status = (await runGit(['status', '--porcelain'])).stdout || ''
      } catch {}
      if (!status.trim()) return { ok: true, reason: 'clean' }

      await runGit(['commit', '-m', `sync: ${reason} @ ${new Date().toISOString()}`])
      try {
        await runGit(['pull', '--rebase', 'origin', GIT_BRANCH])
      } catch (e) {
        console.warn('[git] pull --rebase', (e.stderr || e.message || '').toString().slice(0, 160))
      }
      try {
        await runGit(['push', '-u', 'origin', GIT_BRANCH])
      } catch {
        await runGit(['pull', '--rebase', 'origin', GIT_BRANCH]).catch(() => {})
        await runGit(['push', '-u', 'origin', GIT_BRANCH])
      }
      let head = null
      try {
        head = (await runGit(['rev-parse', '--short', 'HEAD'])).stdout.trim()
      } catch {}
      meta.lastPushAt = new Date().toISOString()
      meta.lastCommit = head
      meta.lastError = null
      meta.pushes++
      console.log('[git] pushed', head, reason)
      return { ok: true, head }
    } catch (e) {
      const msg = (e.stderr?.toString?.() || e.message || String(e)).slice(0, 500)
      console.error('[git] commit/push failed', msg)
      meta.lastError = msg
      return { ok: false, error: msg }
    } finally {
      pushInFlight = false
    }
  }

  function schedulePush(reason = 'save') {
    if (!GIT_ENABLED || !GIT_REPO) return
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      pushTimer = null
      commitAndPush(reason).catch((e) => console.error('[git] push', e.message || e))
    }, GIT_PUSH_DEBOUNCE_MS)
  }

  function startInterval(ms = 10 * 60 * 1000) {
    if (!GIT_ENABLED) return
    setInterval(() => {
      commitAndPush('interval').catch(() => {})
    }, ms)
  }

  return {
    enabled: GIT_ENABLED,
    meta,
    initOrPull,
    commitAndPush,
    schedulePush,
    startInterval,
  }
}

module.exports = { createGitStore, GIT_ENABLED }
