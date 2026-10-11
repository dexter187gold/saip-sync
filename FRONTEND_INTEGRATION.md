# Frontend Integration Guide – sa-invoice-pro

This document tells you exactly what to add to the existing offline-first app so it gains multi-device sync + live status for AutoResponder.

## 1. Config

In `public/legacy/js/config.js` (or wherever `SA_CONFIG` lives) add:

```js
window.SA_CONFIG = Object.assign({
  // … existing keys …
  syncServerUrl: 'https://YOUR-RENDER-URL.onrender.com',   // ← change after deploy
  syncEnabled: true,
}, window.SA_CONFIG || {});
```

## 2. Minimal Sync Module

Create a new file `public/legacy/js/sync.js`:

```js
/* SA Invoice Pro – Cloud Sync helper */
window.SA_SYNC = {
  token: localStorage.getItem('saip_sync_token') || null,

  get base() {
    return (window.SA_CONFIG && window.SA_CONFIG.syncServerUrl) || '';
  },

  async request(path, opts = {}) {
    if (!this.base) throw new Error('syncServerUrl not configured');
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    const res = await fetch(this.base + path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  },

  async register(email, password, name) {
    const data = await this.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });
    this.token = data.token;
    localStorage.setItem('saip_sync_token', data.token);
    return data;
  },

  async login(email, password) {
    const data = await this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    this.token = data.token;
    localStorage.setItem('saip_sync_token', data.token);
    return data;
  },

  logout() {
    this.token = null;
    localStorage.removeItem('saip_sync_token');
  },

  async pull() {
    return this.request('/api/workspace');
  },

  async push(workspaceData) {
    return this.request('/api/workspace', {
      method: 'PUT',
      body: JSON.stringify({ data: workspaceData }),
    });
  },

  /** Call after create / pay / edit invoice */
  async pushInvoiceStatus(invoices) {
    const list = Array.isArray(invoices) ? invoices : [invoices];
    return this.request('/api/status/push', {
      method: 'POST',
      body: JSON.stringify({ invoices: list }),
    });
  },
};
```

Include the script in `index.html` **before** `app.js`.

## 3. Call points inside app.js (high-level)

You will need to wire these calls (search for the relevant functions):

### After successful login / app boot
```js
if (window.SA_SYNC && SA_CONFIG.syncEnabled && SA_SYNC.token) {
  try {
    const remote = await SA_SYNC.pull();
    // merge remote.data into your IndexedDB stores
    // (clients, invoices, tickets, settings)
    // simple strategy for v1: if remote is newer, replace local
  } catch (e) {
    console.warn('Sync pull failed', e);
  }
}
```

### After saving an invoice / recording payment
```js
if (window.SA_SYNC && SA_SYNC.token) {
  // Build a small status object
  const status = {
    invoice_number: inv.number,
    client_name: client.name,
    client_phone: client.phone,
    total: inv.total,
    balance_due: inv.total - (inv.amountPaid || 0),
    status: balance <= 0 ? 'paid' : (paid > 0 ? 'partial' : 'unpaid'),
    due_date: inv.dueDate,
  };
  SA_SYNC.pushInvoiceStatus(status).catch(console.warn);

  // Also push full workspace occasionally (e.g. every 5 saves or on app close)
  // SA_SYNC.push(fullWorkspaceObject).catch(console.warn);
}
```

### New UI: Cloud Account section in Settings
Add a simple card:
- Email + password fields
- Login / Register / Logout buttons
- “Last synced: …” indicator

## 4. AutoResponder live status rules

Once the server is live, create an Expert rule:

**Received:** `.*\b(invoice|inv|status)\b.*`

**Reply type:** Web Server  
**URL:**  
`https://YOUR-RENDER-URL.onrender.com/api/status/invoice?number=%message_match_1%&token=YOUR_STATUS_API_TOKEN`

(You will need a small regex capture or ask the user for the number first, then hit the endpoint.)

A more robust pattern is a two-step flow:
1. Ask for invoice number
2. On the next message that looks like INV-xxxx, call the status endpoint and reply with the JSON result formatted nicely.

## 5. Suggested rollout order (today)

1. Deploy this `saip-sync` repo to Render
2. Set strong secrets in Render env
3. Add `sync.js` + config change to sa-invoice-pro
4. Add Login/Register UI in Settings
5. Wire the push calls after invoice save / payment
6. Test pull on a second device
7. Point AutoResponder at the public status endpoint

That gives you multi-device + live AutoResponder the same day.
