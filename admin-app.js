(function () {
  var token = localStorage.getItem("saip_admin_token") || "";
  var currentTab = "dash";
  var usersCache = [];

  function toast(m) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = m || "";
    el.classList.remove("hidden");
    setTimeout(function () { el.classList.add("hidden"); }, 2800);
  }
  function showErr(m) {
    var e = document.getElementById("login-err");
    if (e) e.textContent = m || "";
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">").replace(/"/g, """);
  }
  function money(n) {
    var x = Number(n) || 0;
    try { return new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(x); }
    catch (e) { return "R" + x.toFixed(2); }
  }
  function fetchJson(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (token) headers.Authorization = "Bearer " + token;
    return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || r.statusText || "Request failed");
        return j;
      });
    });
  }

  var TITLES = {
    dash: ["Dashboard", "Users & workspaces"],
    users: ["Users", "Add · role · reset password · remove"],
    invoices: ["Invoices", "All workspaces"],
    tickets: ["Tickets", "All workspaces"],
    clients: ["Clients", "All workspaces"],
    devices: ["Devices", "Bound fingerprints"],
    portals: ["Portals", "Client portal links"],
    branches: ["Branches", "Branch workspaces"],
    system: ["System", "Health & git"]
  };

  function setPage(tab) {
    currentTab = tab;
    var t = TITLES[tab] || [tab, ""];
    var ht = document.getElementById("page-title");
    var hs = document.getElementById("page-sub");
    if (ht) ht.textContent = t[0];
    if (hs) hs.textContent = t[1];
    ["dash","users","invoices","tickets","clients","devices","portals","branches","system"].forEach(function (n) {
      var el = document.getElementById("panel-" + n);
      if (el) el.classList.toggle("hidden", n !== tab);
    });
    document.querySelectorAll("[data-tab]").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-tab") === tab);
    });
  }

  function goTab(tab) {
    setPage(tab);
    var loaders = {
      dash: loadDash, users: loadUsers, invoices: loadInvoices, tickets: loadTickets,
      clients: loadClients, devices: loadDevices, portals: loadPortals, branches: loadBranchesAdmin, system: loadSystem
    };
    if (loaders[tab]) loaders[tab]().catch(function (e) { toast(e.message); });
  }

  function showApp() {
    document.getElementById("login").classList.add("hidden");
    document.getElementById("app").classList.add("on");
    goTab("dash");
  }

  function doLogin() {
    var button = document.getElementById("btn-login");
    var emailEl = document.getElementById("email");
    var passwordEl = document.getElementById("password");
    if (!emailEl || !passwordEl) { showErr("Sign-in form did not load correctly. Refresh this page."); return; }
    var email = (emailEl.value || "").trim();
    var password = passwordEl.value || "";
    showErr("");
    if (!email || !password) { showErr("Enter your email and password."); return; }
    if (button) { button.disabled = true; button.textContent = "Signing in…"; }
    fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password })
    }).then(function (r) {
      return r.text().then(function (body) {
        var data;
        try { data = JSON.parse(body); } catch (_) { throw new Error("The server returned an unreadable response (HTTP " + r.status + ")."); }
        if (!r.ok) throw new Error(data.error || "Sign-in failed (HTTP " + r.status + ").");
        if (!data.token) throw new Error("The server did not return a sign-in token.");
        return fetch("/api/admin/me", { headers: { Authorization: "Bearer " + data.token } })
          .then(function (r2) { return r2.text().then(function (body2) {
            var me;
            try { me = JSON.parse(body2); } catch (_) { throw new Error("Could not verify administrator access (HTTP " + r2.status + ")."); }
            if (!r2.ok) throw new Error(me.error || "This account does not have administrator access.");
            return { token: data.token, me: me };
          }); });
      });
    }).then(function (result) {
      token = result.token;
      localStorage.setItem("saip_admin_token", token);
      showApp();
      toast("Signed in");
    }).catch(function (e) {
      showErr(e && e.message ? e.message : "Sign-in failed. Please try again.");
    }).finally(function () {
      if (button) { button.disabled = false; button.textContent = "Sign in"; }
    });
  }

  function loadDash() {
    return Promise.all([fetchJson("/api/admin/stats"), fetchJson("/health")]).then(function (arr) {
      var s = (arr[0].stats) || {};
      var el = document.getElementById("panel-dash");
      el.innerHTML =
        '<div class="stat-grid">' +
        '<div class="stat"><div class="l">Users</div><div class="v">' + (s.users || 0) + "</div></div>" +
        '<div class="stat"><div class="l">Workspaces</div><div class="v">' + (s.workspaces || 0) + "</div></div>" +
        '<div class="stat"><div class="l">Invoices</div><div class="v">' + (s.invoices || 0) + "</div></div>" +
        '<div class="stat"><div class="l">Tickets</div><div class="v">' + (s.tickets || 0) + "</div></div>" +
        '<div class="stat"><div class="l">Devices</div><div class="v">' + (s.devices || 0) + "</div></div>" +
        '<div class="stat"><div class="l">Portals</div><div class="v">' + (s.portals || 0) + "</div></div>" +
        '<div class="stat"><div class="l">Branch WS</div><div class="v">' + (s.branch_workspaces || 0) + "</div></div>" +
        "</div>";
    });
  }

  function loadUsers() {
    return fetchJson("/api/admin/users").then(function (d) {
      usersCache = d.users || [];
      renderUsersPanel();
    });
  }

  function renderUsersPanel() {
    var users = usersCache;
    var rows = users.map(function (u) {
      var roleOpts = ['user', 'admin'].map(function (r) {
        return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + r + '</option>';
      }).join('');
      return (
        '<tr data-id="' + esc(u.id) + '">' +
        '<td><strong>' + esc(u.email) + '</strong><br><span style="font-size:12px;color:var(--muted)">' + esc(u.name || '—') + '</span></td>' +
        '<td><select class="input role-sel" data-id="' + esc(u.id) + '" style="min-width:90px;padding:6px 8px">' + roleOpts + '</select></td>' +
        '<td>' + (u.has_workspace ? 'yes' : 'no') + '</td>' +
        '<td>' + (u.google ? 'Google' : '—') + '</td>' +
        '<td style="white-space:nowrap">' +
        '<button type="button" class="btn btn-outline btn-sm btn-reset" data-id="' + esc(u.id) + '" data-email="' + esc(u.email) + '" style="margin-right:4px">Reset PW</button>' +
        '<button type="button" class="btn btn-outline btn-sm btn-del" data-id="' + esc(u.id) + '" data-email="' + esc(u.email) + '" data-role="' + esc(u.role) + '" style="color:var(--danger)">Remove</button>' +
        '</td></tr>'
      );
    }).join('');

    var html =
      '<div class="card" style="margin-bottom:14px">' +
      '<h3 style="margin:0 0 10px;font-size:1rem">Add cloud user</h3>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;align-items:end">' +
      '<div><label style="font-size:12px;color:var(--muted)">Email</label><input id="nu-email" class="input" type="email" placeholder="tech@shop.co.za"/></div>' +
      '<div><label style="font-size:12px;color:var(--muted)">Name</label><input id="nu-name" class="input" type="text" placeholder="Optional"/></div>' +
      '<div><label style="font-size:12px;color:var(--muted)">Password (≥12 chars)</label><input id="nu-pw" class="input" type="password" autocomplete="new-password"/></div>' +
      '<div><label style="font-size:12px;color:var(--muted)">Role</label><select id="nu-role" class="input"><option value="user">user</option><option value="admin">admin</option></select></div>' +
      '<div><label style="font-size:12px;display:flex;gap:6px;align-items:center"><input id="nu-ws" type="checkbox" checked/> Create workspace</label>' +
      '<button type="button" class="btn" id="btn-create-user" style="width:100%;margin-top:6px">Create user</button></div>' +
      '</div>' +
      '<p style="font-size:12px;color:var(--muted);margin:10px 0 0">Password is never shown after create. Share it out-of-band. Workspace holds invoices/tickets for that account.</p>' +
      '</div>' +
      '<div class="card"><strong>' + users.length + '</strong> accounts</div>' +
      '<table><thead><tr><th>Email / Name</th><th>Role</th><th>WS</th><th>Auth</th><th>Actions</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5">None</td></tr>') +
      '</tbody></table>';

    var panel = document.getElementById("panel-users");
    panel.innerHTML = html;

    var createBtn = document.getElementById("btn-create-user");
    if (createBtn) {
      createBtn.addEventListener("click", function () {
        var email = (document.getElementById("nu-email").value || "").trim();
        var name = (document.getElementById("nu-name").value || "").trim();
        var password = document.getElementById("nu-pw").value || "";
        var role = document.getElementById("nu-role").value || "user";
        var createWorkspace = document.getElementById("nu-ws").checked;
        if (!email) return toast("Email required");
        if (password.length < 12) return toast("Password must be at least 12 characters");
        createBtn.disabled = true;
        createBtn.textContent = "Creating…";
        fetchJson("/api/admin/users", {
          method: "POST",
          body: JSON.stringify({ email: email, name: name || null, password: password, role: role, createWorkspace: createWorkspace })
        })
          .then(function () {
            toast("User created");
            document.getElementById("nu-email").value = "";
            document.getElementById("nu-name").value = "";
            document.getElementById("nu-pw").value = "";
            return loadUsers();
          })
          .catch(function (e) { toast(e.message || "Create failed"); })
          .finally(function () {
            createBtn.disabled = false;
            createBtn.textContent = "Create user";
          });
      });
    }

    panel.querySelectorAll(".role-sel").forEach(function (sel) {
      sel.addEventListener("change", function () {
        var id = sel.getAttribute("data-id");
        var role = sel.value;
        if (!window.confirm("Change role to " + role + "?")) {
          loadUsers();
          return;
        }
        fetchJson("/api/admin/users/" + encodeURIComponent(id), {
          method: "PATCH",
          body: JSON.stringify({ role: role })
        })
          .then(function () { toast("Role updated"); return loadUsers(); })
          .catch(function (e) { toast(e.message); loadUsers(); });
      });
    });

    panel.querySelectorAll(".btn-reset").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        var email = btn.getAttribute("data-email");
        var pw = window.prompt("New password for " + email + " (min 12 characters):");
        if (pw == null) return;
        if (pw.length < 12) return toast("Password must be at least 12 characters");
        fetchJson("/api/admin/users/" + encodeURIComponent(id) + "/reset-password", {
          method: "POST",
          body: JSON.stringify({ password: pw })
        })
          .then(function () { toast("Password reset — share new password securely"); })
          .catch(function (e) { toast(e.message); });
      });
    });

    panel.querySelectorAll(".btn-del").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        var email = btn.getAttribute("data-email");
        var role = btn.getAttribute("data-role");
        if (role === "admin") {
          toast("Demote admin to user first, then remove");
          return;
        }
        if (!window.confirm("Permanently delete " + email + " and their workspace? This cannot be undone.")) return;
        fetchJson("/api/admin/users/" + encodeURIComponent(id), { method: "DELETE" })
          .then(function () { toast("User removed"); return loadUsers(); })
          .catch(function (e) { toast(e.message); });
      });
    });
  }

  function loadInvoices() {
    return fetchJson("/api/admin/invoices").then(function (d) {
      var list = d.invoices || [];
      var rows = list.map(function (i) {
        return "<tr><td>" + esc(i.number || "-") + "</td><td>" + esc(i.client_name || "-") + "</td><td>" +
          money(i.balance_due != null ? i.balance_due : i.total) + "</td><td>" + esc(i.status || "-") +
          "</td><td>" + esc(i.owner_email || "") + "</td></tr>";
      }).join("");
      document.getElementById("panel-invoices").innerHTML =
        '<div class="card"><strong>' + list.length + "</strong> invoices</div>" +
        "<table><thead><tr><th>#</th><th>Client</th><th>Bal</th><th>Status</th><th>Owner</th></tr></thead><tbody>" +
        (rows || "<tr><td colspan=5>None</td></tr>") + "</tbody></table>";
    });
  }

  function loadTickets() {
    return fetchJson("/api/admin/tickets").then(function (d) {
      var list = d.tickets || [];
      var rows = list.map(function (t) {
        return "<tr><td>" + esc(t.title || t.number || t.id) + "</td><td>" + esc(t.status || "") +
          "</td><td>" + esc(t.owner_email || "") + "</td></tr>";
      }).join("");
      document.getElementById("panel-tickets").innerHTML =
        "<table><thead><tr><th>Job</th><th>Status</th><th>Owner</th></tr></thead><tbody>" +
        (rows || "<tr><td colspan=3>None</td></tr>") + "</tbody></table>";
    });
  }

  function loadClients() {
    return fetchJson("/api/admin/clients").then(function (d) {
      var list = d.clients || [];
      var rows = list.map(function (c) {
        return "<tr><td>" + esc(c.name || "") + "</td><td>" + esc(c.phone || "") +
          "</td><td>" + esc(c.owner_email || "") + "</td></tr>";
      }).join("");
      document.getElementById("panel-clients").innerHTML =
        "<table><thead><tr><th>Name</th><th>Phone</th><th>Owner</th></tr></thead><tbody>" +
        (rows || "<tr><td colspan=3>None</td></tr>") + "</tbody></table>";
    });
  }

  function loadDevices() {
    return fetchJson("/api/admin/devices").then(function (d) {
      var list = d.devices || [];
      var rows = list.map(function (x) {
        return "<tr><td>" + esc(x.owner_email || "") + "</td><td>" + esc(x.label || "") + "</td><td>" +
          esc(x.ip || "") + "</td><td>" + esc((x.lastSeen || x.boundAt || "").slice(0, 19)) + "</td></tr>";
      }).join("");
      document.getElementById("panel-devices").innerHTML =
        '<div class="card"><strong>' + list.length + "</strong> bound devices</div>" +
        "<table><thead><tr><th>Owner</th><th>Label</th><th>IP</th><th>Seen</th></tr></thead><tbody>" +
        (rows || "<tr><td colspan=4>None yet</td></tr>") + "</tbody></table>";
    });
  }

  function loadPortals() {
    return fetchJson("/api/admin/portals").then(function (d) {
      var list = d.portals || [];
      var rows = list.map(function (x) {
        return "<tr><td>" + esc(x.owner_email || "") + "</td><td>" + esc(x.clientId || "") + "</td><td>" +
          esc((x.expires || "").slice(0, 10)) + '</td><td><a href="' + esc(x.url || "#") + '" target="_blank" rel="noopener">Open</a></td></tr>';
      }).join("");
      document.getElementById("panel-portals").innerHTML =
        '<div class="card"><strong>' + list.length + "</strong> portal links</div>" +
        "<table><thead><tr><th>Owner</th><th>Client</th><th>Expires</th><th></th></tr></thead><tbody>" +
        (rows || "<tr><td colspan=4>None</td></tr>") + "</tbody></table>";
    });
  }

  function loadBranchesAdmin() {
    return fetchJson("/api/admin/branches").then(function (d) {
      var list = d.branches || [];
      var rows = list.map(function (x) {
        return "<tr><td>" + esc(x.owner_email || "") + "</td><td>" + esc(x.branchId || "") + "</td><td>" +
          (x.version || 0) + "</td><td>" + esc((x.updated_at || "").slice(0, 19)) + "</td></tr>";
      }).join("");
      document.getElementById("panel-branches").innerHTML =
        '<div class="card"><strong>' + list.length + "</strong> branch workspaces</div>" +
        "<table><thead><tr><th>Owner</th><th>Branch</th><th>Ver</th><th>Updated</th></tr></thead><tbody>" +
        (rows || "<tr><td colspan=4>None</td></tr>") + "</tbody></table>";
    });
  }

  function loadSystem() {
    return fetchJson("/health").then(function (h) {
      document.getElementById("panel-system").innerHTML =
        '<div class="card"><pre style="white-space:pre-wrap;font-size:12px;margin:0">' +
        esc(JSON.stringify(h, null, 2)) + "</pre></div>";
      var g = document.getElementById("git-badge");
      if (g) g.textContent = "v" + (h.version || "?") + " · users " + (h.users || 0);
    });
  }

  window.SAIPAdminLogin = doLogin;

  window.addEventListener("error", function (event) {
    showErr("Admin page script error: " + (event.message || "unknown error"));
  });
  window.addEventListener("unhandledrejection", function (event) {
    showErr("Admin page request failed: " + (event.reason && event.reason.message ? event.reason.message : "unknown error"));
  });

  function boot() {
    var loginButton = document.getElementById("btn-login");
    if (loginButton) loginButton.addEventListener("click", doLogin);
    document.getElementById("password").addEventListener("keydown", function (e) {
      if (e.key === "Enter") doLogin();
    });
    document.getElementById("btn-logout").addEventListener("click", function () {
      token = "";
      localStorage.removeItem("saip_admin_token");
      location.reload();
    });
    document.getElementById("btn-refresh").addEventListener("click", function () { goTab(currentTab); });
    document.querySelectorAll("[data-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () { goTab(btn.getAttribute("data-tab")); });
    });
    if (token) {
      fetchJson("/api/admin/me").then(function () { showApp(); }).catch(function () {
        token = "";
        localStorage.removeItem("saip_admin_token");
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
