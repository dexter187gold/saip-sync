(function () {
  var token = localStorage.getItem("saip_admin_token") || "";
  var currentTab = "dash";

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
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
    users: ["Users", "Cloud accounts"],
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
    var email = (document.getElementById("email").value || "").trim();
    var password = document.getElementById("password").value || "";
    showErr("");
    fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password })
    }).then(function (r) { return r.json().then(function (j) { return { r: r, j: j }; }); })
      .then(function (x) {
        if (!x.r.ok) throw new Error(x.j.error || "Login failed");
        return fetch("/api/admin/me", { headers: { Authorization: "Bearer " + x.j.token } })
          .then(function (r2) { return r2.json().then(function (j2) { return { token: x.j.token, me: j2, ok: r2.ok }; }); });
      })
      .then(function (x) {
        if (!x.ok) throw new Error((x.me && x.me.error) || "Not an admin account");
        token = x.token;
        localStorage.setItem("saip_admin_token", token);
        showApp();
        toast("Signed in");
      })
      .catch(function (e) { showErr(e.message || "Login failed"); });
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
      var users = d.users || [];
      var rows = users.map(function (u) {
        return "<tr><td>" + esc(u.email) + "</td><td>" + esc(u.role) + "</td><td>" +
          (u.has_workspace ? "yes" : "no") + "</td><td>" + (u.google ? "Google" : "—") + "</td></tr>";
      }).join("");
      document.getElementById("panel-users").innerHTML =
        "<table><thead><tr><th>Email</th><th>Role</th><th>WS</th><th>Auth</th></tr></thead><tbody>" +
        (rows || "<tr><td colspan=4>None</td></tr>") + "</tbody></table>";
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
        "<div class=\"card\"><strong>" + list.length + "</strong> invoices</div>" +
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
        "<div class=\"card\"><strong>" + list.length + "</strong> bound devices</div>" +
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
        "<div class=\"card\"><strong>" + list.length + "</strong> portal links</div>" +
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
        "<div class=\"card\"><strong>" + list.length + "</strong> branch workspaces</div>" +
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

  function boot() {
    document.getElementById("btn-login").addEventListener("click", doLogin);
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
