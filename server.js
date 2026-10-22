/**
 * Reconstruct full server from base64 parts and boot.
 * Temporary recovery from a bad placeholder commit.
 */
const fs = require('fs');
const path = require('path');
const parts = [];
for (let i = 0; i < 20; i++) {
  const f = path.join(__dirname, 'server_b64_' + i + '.txt');
  if (!fs.existsSync(f)) break;
  parts.push(fs.readFileSync(f, 'utf8').trim());
}
if (!parts.length) {
  console.error('Missing server_b64_*.txt parts');
  process.exit(1);
}
const code = Buffer.from(parts.join(''), 'base64').toString('utf8');
const out = path.join(__dirname, '_server_runtime.js');
fs.writeFileSync(out, code);
require('./_server_runtime.js');
