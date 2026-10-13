/**
 * Bridge: WhatsApp registrations & job intake → SA Invoice Pro app
 * - Mark WA clients imported after they land in local clients DB
 * - List / claim job cards from ticketsIntake into the app
 */

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/\D/g, '');
  if (!s) return null;
  if (s.startsWith('0') && s.length === 10) s = '27' + s.slice(1);
  if (s.length < 9) return null;
  return s;
}

function mountIntakeApi(app, ctx) {
  const {
    auth,
    waClients,
    persistWaClients,
    ticketsIntake,
    persistTickets,
    now,
  } = ctx;

  // Already have GET /api/wa/pending in server.js — keep behaviour, add mark-imported

  app.post('/api/wa/pending/:phone/imported', auth, (req, res) => {
    const phone = normalizePhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'Invalid phone' });
    const row = waClients[phone];
    if (!row) return res.status(404).json({ error: 'WA client not found' });
    const clientId = req.body?.client_id || req.body?.clientId || null;
    waClients[phone] = {
      ...row,
      pending_import: false,
      linked_client_id: clientId || row.linked_client_id || null,
      owner_user_id: req.user?.id || row.owner_user_id || null,
      imported_at: now(),
      updated_at: now(),
    };
    persistWaClients();
    res.json({ ok: true, client: waClients[phone] });
  });

  /** All WA clients (for admin/app sync), not only pending */
  app.get('/api/wa/clients', auth, (req, res) => {
    const list = Object.values(waClients || {}).map((c) => ({
      id: c.id,
      phone: c.phone,
      name: c.name,
      email: c.email,
      company: c.company,
      address: c.address,
      city: c.city,
      registered: !!c.registered,
      pending_import: !!c.pending_import,
      linked_client_id: c.linked_client_id || null,
      source: c.source,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));
    list.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    res.json({ ok: true, count: list.length, clients: list });
  });

  /** WhatsApp job cards waiting to be pulled into the app */
  app.get('/api/tickets/intake', auth, (req, res) => {
    const items = Array.isArray(ticketsIntake?.items) ? ticketsIntake.items : [];
    const open = items.filter((t) => !t.imported_to_app && t.status !== 'cancelled');
    res.json({
      ok: true,
      count: open.length,
      tickets: open.slice(0, 100),
    });
  });

  /** Mark a server intake ticket as imported into local job cards */
  app.post('/api/tickets/intake/:id/imported', auth, (req, res) => {
    const items = Array.isArray(ticketsIntake?.items) ? ticketsIntake.items : [];
    const t = items.find((x) => String(x.id) === String(req.params.id));
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    t.imported_to_app = true;
    t.imported_at = now();
    t.imported_by = req.user?.id || null;
    t.local_ticket_id = req.body?.ticket_id || req.body?.ticketId || null;
    t.status = t.status === 'new' ? 'imported' : t.status;
    persistTickets();
    res.json({ ok: true, ticket: t });
  });

  /** Optional: list all intake including imported (debug) */
  app.get('/api/tickets/intake/all', auth, (req, res) => {
    const items = Array.isArray(ticketsIntake?.items) ? ticketsIntake.items : [];
    res.json({ ok: true, count: items.length, tickets: items.slice(0, 200) });
  });
}

module.exports = { mountIntakeApi };
