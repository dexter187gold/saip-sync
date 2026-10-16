function mountConfigApi(app, { configStore, adminAuth }) {
  app.get('/api/config/app', (req, res) => {
    try { res.json(configStore.getPublic()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/admin/config', adminAuth, (req, res) => {
    try { res.json(configStore.getAdminView()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/admin/config/public', adminAuth, (req, res) => {
    try {
      const body = req.body?.public || req.body || {};
      res.json(configStore.updatePublic(body, req.adminUser?.email || req.user?.email));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put('/api/admin/config/secrets', adminAuth, (req, res) => {
    try {
      const body = req.body?.secrets || req.body || {};
      res.json(configStore.updateSecrets(body, req.adminUser?.email || req.user?.email));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  console.log('[config] /api/config/app + /api/admin/config mounted');
}
module.exports = { mountConfigApi };
