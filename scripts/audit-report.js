const { execFileSync } = require('node:child_process')

let output = ''
try {
  output = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (error) {
  output = String(error.stdout || '')
}

try {
  const report = JSON.parse(output)
  const vulnerabilities = report.vulnerabilities || {}
  console.log('[npm-audit] summary', JSON.stringify(report.metadata?.vulnerabilities || {}))
  for (const [name, item] of Object.entries(vulnerabilities)) {
    console.log('[npm-audit] package', JSON.stringify({
      name,
      severity: item.severity,
      direct: item.isDirect,
      range: item.range,
      via: item.via,
      fixAvailable: item.fixAvailable,
    }))
  }
} catch {
  console.log('[npm-audit] could not parse npm audit JSON')
}
