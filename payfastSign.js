/**
 * PayFast signature (MD5).
 * https://developers.payfast.co.za/docs#step_2_signature
 */
const crypto = require('crypto')

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex')
}

function buildSignature(data, passphrase = '') {
  const preferred = [
    'merchant_id', 'merchant_key', 'return_url', 'cancel_url', 'notify_url',
    'name_first', 'name_last', 'email_address', 'cell_number',
    'm_payment_id', 'amount', 'item_name', 'item_description',
    'custom_int1', 'custom_str1', 'custom_str2', 'custom_str3', 'custom_str4', 'custom_str5',
  ]
  const ordered = []
  const seen = new Set()
  for (const k of preferred) {
    if (data[k] !== undefined && data[k] !== null && data[k] !== '') {
      ordered.push(k)
      seen.add(k)
    }
  }
  for (const k of Object.keys(data)) {
    if (k === 'signature') continue
    if (seen.has(k)) continue
    if (data[k] === undefined || data[k] === null || data[k] === '') continue
    ordered.push(k)
  }
  const pairs = ordered.map(
    (k) => `${k}=${encodeURIComponent(String(data[k]).trim()).replace(/%20/g, '+')}`,
  )
  let paramString = pairs.join('&')
  if (passphrase) {
    paramString += `&passphrase=${encodeURIComponent(String(passphrase).trim()).replace(/%20/g, '+')}`
  }
  return md5(paramString)
}

module.exports = { buildSignature, md5 }
