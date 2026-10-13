/**
 * Job card status sync — app → server → WhatsApp AutoResponder
 * POST /api/tickets/status (JWT)
 * GET  /api/wa/job-status (status token)
 * GET  /api/ar/outbox (status token)
 * POST /api/ar/outbox/ack (status token)
 */
const path = require('path');
const { v4: uuidv4 } = require('uuid');

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/\D/g, '');
  if (!s) return null;
  if (s.startsWith('0') && s.length === 10) s = '27' + s.slice(1);
  if (s.startsWith('27') && s.length > 11) s = s.slice(0, 11);
  if (s.length < 9 || s.length > 15) return null;
  return s;
}

function statusLabel(s) {
  const map = {
    new: 'Received', open: 'Open', in_progress: 'In progress',
    waiting: 'Waiting on parts / client', resolved: 'Resolved',
    closed: 'Closed', cancelled: 'Cancelled', imported: 'With technician',
  };
  const k = String(s || 'open').toLowerCase();
  return map[k] || k.replace(/_/g, ' ');
}

function formatJobMessage(job, kind) {
  const co = 'PC REPAIR DEX';
  const title = job.title || [job.device, job.issue].filter(Boolean).join(' — ') || 'Your job';
  const lines = [
    kind === 'created' ? `✅ *Job card received — ${co}*` : `🔧 *Job update — ${co}*`,
    '',
    `*Job:* ${title}`,
    `*Status:* ${statusLabel(job.status)}`,
  ];
  if (job.priority) lines.push(`*Priority:* ${job.priority}`);
  if (job.device) lines.push(`*Device:* ${job.device}`);
  if (job.issue) lines.push(`*Issue:* ${job.issue}`);
  if (job.work_done || job.workDone) lines.push('', '*Work done:*', job.work_done || job.workDone);
  if (job.notes && kind !== 'created') lines.push('', '*Note:*', job.notes);
  if (job.status === 'resolved' || job.status === 'closed') {
    lines.push('', 'Thank you for choosing us. Reply *feedback* to rate us.');
  } else {
    lines.push('', 'Reply *status* anytime for the latest update.', '0️⃣ Menu');
  }
  return lines.filter((x) => x != null).join('\n');
}

function mountTicketStatus(app, ctx) {
  const {
    auth, statusAuth, DATA_DIR, loadJson, saveJson,
    ticketsIntake, persistTickets, waClients, persistWaClients,
    pushNotification, now,
  } = ctx;

  const JOBS_FILE = path.join(DATA_DIR, 'job_status.json');
  const OUTBOX_FILE = path.join(DATA_DIR, 'wa_outbox.json');
  let jobStatus = loadJson(JOBS_FILE, {});
  let outbox = loadJson(OUTBOX_FILE, { items: [] });

  function persistJobs() { saveJson(JOBS_FILE, jobStatus); }
  function persistOutbox() { saveJson(OUTBOX_FILE, outbox); }

  function queueOutbox(phone, message, meta = {}) {
    const p = normalizePhone(phone);
    if (!p || !message) return null;
    if (!Array.isArray(outbox.items)) outbox.items = [];
    const item = {
      id: uuidv4(), phone: p, message: String(message), meta,
      created_at: now(), delivered: false,
    };
    outbox.items.unshift(item);
    outbox.items = outbox.items.slice(0, 300);
    persistOutbox();
    return item;
  }

  function jobsForPhone(phone) {
    const p = normalizePhone(phone);
    if (!p) return [];
    const list = Object.values(jobStatus).filter((j) => normalizePhone(j.customer_phone) === p);
    const intake = (ticketsIntake?.items || []).filter(
      (t) => normalizePhone(t.customer_phone) === p && !t.imported && !t.imported_to_app
    );
    for (const t of intake) {
      if (!list.find((j) => j.id === t.id || j.intake_id === t.id)) {
        list.push({
          id: t.id, intake_id: t.id, customer_phone: p,
          customer_name: t.customer_name, device: t.device, issue: t.issue,
          title: [t.device, t.issue].filter(Boolean).join(' — '),
          status: t.status || 'new', priority: t.urgency || 'normal',
          updated_at: t.updated_at || t.created_at, source: 'intake',
        });
      }
    }
    list.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    return list;
  }

  app.post('/api/tickets/status', auth, (req, res) => {
    try {
      const body = req.body || {};
      const tickets = Array.isArray(body.tickets) ? body.tickets : [body];
      const results = [];
      for (const t of tickets) {
        if (!t) continue;
        const id = String(t.id || t.ticket_id || t.local_id || uuidv4());
        const phone = normalizePhone(t.customer_phone || t.contactPhone || t.phone);
        const prev = jobStatus[id];
        const prevStatus = prev?.status;
        const nextStatus = String(t.status || prevStatus || 'open').toLowerCase();
        const row = {
          id,
          local_ticket_id: t.local_ticket_id || t.id || null,
          intake_id: t.intake_id || t.intakeId || prev?.intake_id || null,
          user_id: req.user?.id || null,
          customer_phone: phone,
          customer_name: t.customer_name || t.contactName || t.client_name || prev?.customer_name || null,
          title: t.title || t.subject || prev?.title || null,
          device: t.device || prev?.device || null,
          issue: t.issue || t.description || prev?.issue || null,
          status: nextStatus,
          priority: t.priority || prev?.priority || 'normal',
          work_done: t.work_done || t.workDone || prev?.work_done || null,
          notes: t.notes || prev?.notes || null,
          client_id: t.client_id || t.clientId || prev?.client_id || null,
          updated_at: now(),
          created_at: prev?.created_at || now(),
        };
        jobStatus[id] = row;
        results.push(row);

        if (row.intake_id && ticketsIntake?.items) {
          const it = ticketsIntake.items.find((x) => String(x.id) === String(row.intake_id));
          if (it) { it.status = nextStatus; it.updated_at = now(); }
        }

        if (phone && (row.customer_name || row.client_id)) {
          const existing = waClients[phone] || {};
          waClients[phone] = {
            ...existing,
            id: existing.id || uuidv4(),
            phone,
            name: row.customer_name || existing.name || null,
            linked_client_id: row.client_id || existing.linked_client_id || null,
            owner_user_id: req.user?.id || existing.owner_user_id || null,
            registered: existing.registered != null ? existing.registered : true,
            updated_at: now(),
            created_at: existing.created_at || now(),
            source: existing.source || 'app_ticket_sync',
          };
          if (typeof persistWaClients === 'function') persistWaClients();
        }

        const statusChanged = !prev || prevStatus !== nextStatus;
        const isCreate = !prev;
        if (statusChanged && phone) {
          const kind = isCreate || nextStatus === 'new' || nextStatus === 'open'
            ? 'created'
            : (nextStatus === 'resolved' || nextStatus === 'closed' ? 'closed' : 'updated');
          const msg = formatJobMessage(row, kind);
          queueOutbox(phone, msg, { ticket_id: id, status: nextStatus, kind });
          if (typeof pushNotification === 'function') {
            pushNotification({
              type: 'ticket_status',
              title: 'Job ' + statusLabel(nextStatus),
              body: (row.customer_name || phone) + ': ' + (row.title || row.device || id),
              payload: row,
            });
          }
        }
      }
      persistJobs();
      if (typeof persistTickets === 'function') persistTickets();
      res.json({ ok: true, count: results.length, tickets: results });
    } catch (e) {
      console.error('[ticket-status] push', e);
      res.status(500).json({ error: e.message || 'Failed to save job status' });
    }
  });

  app.get('/api/wa/job-status', statusAuth, (req, res) => {
    const phone = normalizePhone(req.query.phone || req.query.from || '');
    if (!phone) return res.type('text/plain').send('Could not read your number.\n\nReply *menu*.');
    const jobs = jobsForPhone(phone);
    if (!jobs.length) {
      return res.type('text/plain').send([
        '🛠 *Job status*', '', 'No open jobs on this number.',
        'Reply *5* to open a new job card.', '', '0️⃣ Menu',
      ].join('\n'));
    }
    const lines = ['🛠 *Your job status*', ''];
    for (const j of jobs.slice(0, 5)) {
      lines.push('• *' + (j.title || j.device || 'Job') + '*');
      lines.push('  Status: *' + statusLabel(j.status) + '*');
      if (j.updated_at) lines.push('  Updated: ' + String(j.updated_at).slice(0, 16).replace('T', ' '));
      lines.push('');
    }
    lines.push('We will message you when status changes.', '', '0️⃣ Menu');
    res.type('text/plain').send(lines.join('\n'));
  });

  app.get('/api/ar/outbox', statusAuth, (req, res) => {
    const phone = normalizePhone(req.query.phone || req.query.from || '');
    let items = (outbox.items || []).filter((i) => !i.delivered);
    if (phone) items = items.filter((i) => i.phone === phone);
    items = items.slice(0, 20);
    if (req.query.format === 'text' || req.query.text === '1') {
      if (!items.length) return res.type('text/plain').send('');
      return res.type('text/plain').send(items[0].message);
    }
    res.json({
      ok: true,
      count: items.length,
      messages: items.map((i) => ({
        id: i.id, phone: i.phone, message: i.message,
        created_at: i.created_at, meta: i.meta || {},
      })),
    });
  });

  app.post('/api/ar/outbox/ack', statusAuth, (req, res) => {
    const ids = req.body?.ids || (req.body?.id ? [req.body.id] : []);
    const phone = normalizePhone(req.body?.phone || req.query?.phone);
    let n = 0;
    for (const item of outbox.items || []) {
      if (item.delivered) continue;
      if (ids.length && ids.map(String).includes(String(item.id))) {
        item.delivered = true; item.delivered_at = now(); n++;
      } else if (!ids.length && phone && item.phone === phone) {
        item.delivered = true; item.delivered_at = now(); n++;
      }
    }
    persistOutbox();
    res.json({ ok: true, acked: n });
  });

  console.log('[ticket-status] mounted: /api/tickets/status, /api/wa/job-status, /api/ar/outbox');
  return { jobsForPhone, formatJobMessage, statusLabel, queueOutbox };
}

module.exports = { mountTicketStatus, formatJobMessage, statusLabel, normalizePhone };
