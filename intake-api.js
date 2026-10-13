/**
 * SA Invoice Pro – Intake API (WA clients + job-card intake)
 * Mounted from admin.js → used by the Invoice app Inbox / Sync client.
 *
 * Endpoints (JWT required via auth middleware):
 *   GET  /api/wa/pending
 *   POST /api/wa/pending/:phone/imported
 *   GET  /api/tickets/intake
 *   POST /api/tickets/intake/:id/imported
 */
function mountIntakeApi(app, ctx) {
  const {
    auth,
    waClients,
    persistWaClients,
    ticketsIntake,
    persistTickets,
    now,
  } = ctx;

  if (!auth || typeof auth !== 'function') {
    console.error('[intake-api] auth middleware missing — endpoints will not be protected correctly');
  }

  function digits(phone) {
    return String(phone || '').replace(/\D/g, '');
  }

  // ── Pending WhatsApp registrations ──────────────────────────────────────
  app.get('/api/wa/pending', auth, (req, res) => {
    try {
      const list = Object.values(waClients || {})
        .filter((c) => c && (c.pending_import === true || c.pending_import === undefined || c.pending_import === null) && !c.linked_client_id)
        .map((c) => ({
          id: c.id || null,
          phone: c.phone,
          name: c.name || null,
          email: c.email || null,
          company: c.company || null,
          address: c.address || null,
          city: c.city || null,
          source: c.source || 'whatsapp',
          registered: !!c.registered,
          pending_import: true,
          created_at: c.created_at || null,
          updated_at: c.updated_at || null,
        }));
      list.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
      res.json({ ok: true, count: list.length, clients: list });
    } catch (e) {
      console.error('[intake-api] GET /api/wa/pending', e);
      res.status(500).json({ error: e.message || 'Failed to list pending WA clients' });
    }
  });

  app.post('/api/wa/pending/:phone/imported', auth, (req, res) => {
    try {
      const phone = digits(req.params.phone);
      if (!phone) return res.status(400).json({ error: 'Invalid phone' });

      const client = waClients[phone] || Object.values(waClients || {}).find((c) => digits(c.phone) === phone);
      if (!client) {
        return res.json({
          ok: true,
          message: 'No matching WA client found (already cleared or ephemeral storage reset)',
          phone,
        });
      }

      const body = req.body || {};
      client.pending_import = false;
      client.linked_client_id = body.client_id || body.clientId || client.linked_client_id || null;
      client.imported_at = now();
      client.updated_at = now();
      if (typeof persistWaClients === 'function') persistWaClients();

      res.json({
        ok: true,
        phone: client.phone,
        linked_client_id: client.linked_client_id,
      });
    } catch (e) {
      console.error('[intake-api] POST /api/wa/pending/:phone/imported', e);
      res.status(500).json({ error: e.message || 'Mark imported failed' });
    }
  });

  // ── Job-card / ticket intake ─────────────────────────────────────────────
  app.get('/api/tickets/intake', auth, (req, res) => {
    try {
      const items = (ticketsIntake && Array.isArray(ticketsIntake.items) ? ticketsIntake.items : [])
        .filter((t) => t && !t.imported && !t.imported_to_app && t.status !== 'imported' && t.status !== 'done' && t.status !== 'cancelled')
        .map((t) => ({
          id: t.id,
          device: t.device || t.title || null,
          issue: t.issue || t.description || t.subject || null,
          customer_name: t.customer_name || t.contactName || t.name || null,
          customer_phone: t.customer_phone || t.contactPhone || t.phone || null,
          urgency: t.urgency || t.priority || 'normal',
          status: t.status || 'new',
          source: t.source || 'whatsapp',
          created_at: t.created_at || t.createdAt || null,
          updated_at: t.updated_at || t.updatedAt || null,
        }));
      items.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
      res.json({ ok: true, count: items.length, tickets: items });
    } catch (e) {
      console.error('[intake-api] GET /api/tickets/intake', e);
      res.status(500).json({ error: e.message || 'Failed to list intake tickets' });
    }
  });

  app.post('/api/tickets/intake/:id/imported', auth, (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Missing intake id' });

      const items = ticketsIntake && Array.isArray(ticketsIntake.items) ? ticketsIntake.items : [];
      const t = items.find((x) => String(x.id) === id);
      if (!t) {
        return res.json({
          ok: true,
          message: 'Intake ticket not found (may already be cleared)',
          id,
        });
      }

      const body = req.body || {};
      t.imported = true;
      t.imported_to_app = true;
      t.status = 'imported';
      t.local_ticket_id = body.ticket_id || body.ticketId || null;
      t.imported_at = now();
      t.updated_at = now();
      if (typeof persistTickets === 'function') persistTickets();

      res.json({
        ok: true,
        id: t.id,
        local_ticket_id: t.local_ticket_id,
      });
    } catch (e) {
      console.error('[intake-api] POST /api/tickets/intake/:id/imported', e);
      res.status(500).json({ error: e.message || 'Mark ticket imported failed' });
    }
  });

  console.log('[intake-api] mounted: /api/wa/pending, /api/tickets/intake (+ mark-imported)');
}

module.exports = { mountIntakeApi };
