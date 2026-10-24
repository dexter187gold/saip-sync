(function(){
  var token = localStorage.getItem("saip_admin_token") || "";
  var DEFAULT_EMAIL = "admin@sainvoice.pro";
  var DEFAULT_PASS = "Admin@SAIP2026!";
  var currentTab = "dash";

  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem("saip_admin_theme", t);
    var label = t === "light" ? "Dark mode" : "Light mode";
    ["btn-theme", "btn-theme-login"].forEach(function(id){
      var el = document.getElementById(id);
      if (el) el.textContent = label;
    });
  }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(cur === "dark" ? "light" : "dark");
  }
  applyTheme(localStorage.getItem("saip_admin_theme") || "dark");

  function toast(m){
    var e = document.getElementById("toast");
    e.textContent = m;
    e.style.display = "block";
    setTimeout(function(){ e.style.display = "none"; }, 4200);
  }
  function showErr(m){ document.getElementById("login-err").textContent = m || ""; }
  function esc(s){
    return String(s == null ? "" : s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function fetchJson(path, opts, attempt){
    attempt = attempt || 1;
    opts = opts || {};
    var headers = { "Content-Type": "application/json", "Accept": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function(){ if (ctrl) ctrl.abort(); }, 55000);
    return fetch(path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
      credentials: "same-origin"
    }).then(function(r){
      clearTimeout(timer);
      return r.text().then(function(txt){
        var data = {};
        try { data = txt ? JSON.parse(txt) : {}; } catch(e) { data = { error: txt || r.statusText }; }
        if (!r.ok) throw new Error(data.error || data.message || ("HTTP " + r.status));
        return data;
      });
    }).catch(function(err){
      clearTimeout(timer);
      var msg = (err && err.message) ? err.message : String(err);
      var isNet = /abort|Failed to fetch|NetworkError|network|timeout|interrupted/i.test(msg);
      if (isNet && attempt < 3) {
        showErr("Server waking up… retry " + (attempt + 1) + "/3");
        return new Promise(function(resolve){ setTimeout(resolve, 2500 * attempt); })
          .then(function(){ return fetchJson(path, opts, attempt + 1); });
      }
      if (isNet) throw new Error("Network interrupted — wake the server, wait 20s, then sign in.");
      throw err;
    });
  }

  function setPage(tab) {
    currentTab = tab;
    var titles = {
      dash: ["Dashboard", "Overview of users and sync"],
      users: ["Users", "Cloud accounts and roles"],
      wa: ["WhatsApp", "Registered and pending clients"],
      tickets: ["Tickets", "Intake queue"],
      invoices: ["Invoices", "Status snapshot"],
      outbox: ["Outbox", "Queued WhatsApp messages"],
      system: ["System", "Health, git durability, environment"],
      secrets: ["Configuration", "Public config and secrets"],
      tools: ["Tools", "Lookup and force register"]
    };
    var t = titles[tab] || [tab, ""];
    document.getElementById("page-title").textContent = t[0];
    document.getElementById("page-sub").textContent = t[1];
  }

  function showApp(){
    document.getElementById("login").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    refreshGitBadge();
    loadDash().catch(function(e){ toast(e.message); });
  }

  function refreshGitBadge() {
    fetchJson("/health").then(function(h){
      var g = (h && h.git) || {};
      var el = document.getElementById("git-badge");
      if (!el) return;
      var on = !!g.enabled && !g.error;
      el.innerHTML = '<span class="dot ' + (on ? "on" : "off") + '"></span>Git ' +
        (g.enabled ? (g.error ? "error" : "connected") : "off") +
        (g.lastCommit ? " · " + esc(g.lastCommit) : "");
    }).catch(function(){});
  }

  function doLogin(){
    showErr("");
    document.getElementById("login-hint").textContent = "";
    var email = document.getElementById("email").value.trim();
    var password = document.getElementById("password").value;
    if (!email || !password){ showErr("Enter email and password."); return; }
    var btn = document.getElementById("btn-login");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    fetchJson("/health").catch(function(){ return null; }).then(function(){
      return fetchJson("/api/auth/login", { method: "POST", body: { email: email, password: password } });
    }).then(function(d){
      if (!d || !d.token) throw new Error("No token returned");
      token = d.token;
      localStorage.setItem("saip_admin_token", token);
      return fetchJson("/api/admin/me");
    }).then(function(me){
      document.getElementById("who").textContent = (me.admin && me.admin.email) || email;
      showApp();
      toast("Signed in as administrator");
    }).catch(function(e){
      var msg = (e && e.message) ? e.message : String(e);
      if (/Invalid email or password/i.test(msg)) msg = "Invalid credentials. Try Use default or your ADMIN_PASSWORD.";
      else if (/Admin access required/i.test(msg)) msg = "Account is not admin. Use admin@sainvoice.pro";
      showErr(msg);
      document.getElementById("login-hint").textContent = "Tip: Wake server → Use default → Sign in.";
      localStorage.removeItem("saip_admin_token");
      token = "";
    }).finally(function(){
      btn.disabled = false;
      btn.textContent = "Sign in";
    });
  }

  document.getElementById("btn-fill").onclick = function(){
    document.getElementById("email").value = DEFAULT_EMAIL;
    document.getElementById("password").value = DEFAULT_PASS;
    showErr("");
    toast("Default credentials filled");
  };
  document.getElementById("btn-login").onclick = doLogin;
  document.getElementById("btn-wake").onclick = function(){
    showErr("Waking server…");
    fetchJson("/health").then(function(h){
      showErr("");
      toast("Server online · v" + (h.version || "?") + " · users " + (h.users || 0));
    }).catch(function(e){ showErr(e.message); });
  };
  document.getElementById("password").addEventListener("keydown", function(e){ if (e.key === "Enter") doLogin(); });
  document.getElementById("email").addEventListener("keydown", function(e){ if (e.key === "Enter") doLogin(); });
  document.getElementById("btn-logout").onclick = function(){
    token = "";
    localStorage.removeItem("saip_admin_token");
    location.reload();
  };
  document.getElementById("btn-theme").onclick = toggleTheme;
  document.getElementById("btn-theme-login").onclick = toggleTheme;
  document.getElementById("btn-refresh").onclick = function(){
    var map = { dash: loadDash, users: loadUsers, wa: loadWa, tickets: loadTickets, invoices: loadInvoices, outbox: loadOutbox, system: loadSystem, secrets: loadSecrets, tools: loadTools };
    var fn = map[currentTab];
    if (fn) fn().catch(function(e){ toast(e.message); });
    refreshGitBadge();
  };

  document.querySelectorAll(".nav-item[data-tab]").forEach(function(btn){
    btn.onclick = function(){
      var tab = btn.getAttribute("data-tab");
      ["dash","users","wa","tickets","invoices","outbox","system","secrets","tools"].forEach(function(n){
        var el = document.getElementById("panel-" + n);
        if (el) el.classList.toggle("hidden", n !== tab);
      });
      document.querySelectorAll(".nav-item").forEach(function(b){ b.classList.toggle("active", b === btn); });
      setPage(tab);
      var loaders = { dash: loadDash, users: loadUsers, wa: loadWa, tickets: loadTickets, invoices: loadInvoices, outbox: loadOutbox, system: loadSystem, secrets: loadSecrets, tools: loadTools };
      if (loaders[tab]) loaders[tab]().catch(function(e){ toast(e.message); });
    };
  });

  function loadDash(){
    return Promise.all([
      fetchJson("/api/admin/stats"),
      fetchJson("/health")
    ]).then(function(arr){
      var d = arr[0], h = arr[1] || {};
      var s = d.stats || {};
      var g = h.git || {};
      document.getElementById("panel-dash").innerHTML =
        "<div class=\"stat-grid\">"+
        "<div class=\"stat\"><div class=\"l\">Users</div><div class=\"v\">"+(s.users||0)+"</div></div>"+
        "<div class=\"stat\"><div class=\"l\">Workspaces</div><div class=\"v\">"+(s.workspaces||0)+"</div></div>"+
        "<div class=\"stat\"><div class=\"l\">WA clients</div><div class=\"v\">"+(s.wa_clients||0)+"</div></div>"+
        "<div class=\"stat\"><div class=\"l\">Tickets</div><div class=\"v\">"+(s.tickets_total||s.tickets||0)+"</div></div>"+
        "</div>"+
        "<div class=\"card\" style=\"margin-top:12px\"><h3>Git durability</h3>"+
        "<p class=\"sub\">"+(g.enabled?"Connected":"Off")+" · pushes "+(g.pushes||0)+" · pulls "+(g.pulls||0)+
        (g.lastPushAt?" · last push "+esc(g.lastPushAt):"")+"</p></div>";
    });
  }

  function loadUsers(){
    return fetchJson("/api/admin/users").then(function(d){
      var rows = (d.users||[]).map(function(u){
        return "<tr><td>"+esc(u.email)+"<div style=\"color:var(--muted);font-size:.75rem\">"+esc(u.name||"")+"</div></td>"+
          "<td><span class=\"pill "+(u.role==="admin"?"ok":"")+"\">"+esc(u.role||"user")+"</span></td>"+
          "<td>"+(u.has_workspace?"yes":"no")+"</td>"+
          "<td class=\"row\">"+
          "<button type=\"button\" class=\"btn-ok btn-sm\" data-act=\"reset-pw\" data-id=\""+esc(u.id)+"\">Reset PW</button>"+
          (u.role==="admin"?"":"<button type=\"button\" class=\"btn-outline btn-sm\" data-act=\"make-admin\" data-id=\""+esc(u.id)+"\">Make admin</button>")+
          "<button type=\"button\" class=\"btn-danger btn-sm\" data-act=\"del-user\" data-id=\""+esc(u.id)+"\">Delete</button>"+
          "</td></tr>";
      }).join("");
      document.getElementById("panel-users").innerHTML =
        "<div class=\"toolbar\"><input id=\"user-q\" placeholder=\"Filter email / name…\"/><button type=\"button\" class=\"btn btn-secondary btn-sm\" data-act=\"filter-users\">Filter</button></div>"+
        "<table><thead><tr><th>Email</th><th>Role</th><th>Workspace</th><th>Actions</th></tr></thead><tbody>"+(rows||"<tr><td colspan=4>No users</td></tr>")+"</tbody></table>";
    });
  }

  function loadWa(){
    return fetchJson("/api/admin/wa-clients").then(function(d){
      var rows = (d.clients||[]).map(function(c){
        var phone = esc(c.phone||c.id||"");
        return "<tr><td>"+esc(c.name||"—")+"<div style=\"color:var(--muted);font-size:.75rem\">"+phone+"</div></td><td>"+esc(c.email||"—")+"</td><td>"+(c.registered?"<span class=\"pill ok\">yes</span>":"<span class=\"pill\">no</span>")+"</td><td class=\"row\">"+(c.registered?"":"<button type=\"button\" class=\"btn-ok\" data-act=\"force-wa\" data-phone=\""+phone+"\">Mark reg</button>")+"<button type=\"button\" class=\"btn-danger\" data-act=\"delwa\" data-phone=\""+phone+"\">Remove</button></td></tr>";
      }).join("");
      document.getElementById("panel-wa").innerHTML = "<h3>WhatsApp clients ("+(d.count||0)+")</h3><table><thead><tr><th>Client</th><th>Email</th><th>Reg</th><th>Actions</th></tr></thead><tbody>"+(rows||"<tr><td colspan=4>None yet</td></tr>")+"</tbody></table>";
    });
  }

  function loadTickets(){
    return fetchJson("/api/admin/tickets").then(function(d){
      var rows = (d.tickets||[]).map(function(t){
        return "<tr><td>"+esc(t.customer_name||t.customer_phone||"—")+"</td><td>"+esc(t.device||"—")+"</td><td>"+esc(t.issue||t.summary||"—")+"</td><td>"+esc(t.status||"new")+"</td></tr>";
      }).join("");
      document.getElementById("panel-tickets").innerHTML = "<h3>Intake tickets</h3><table><thead><tr><th>Customer</th><th>Device</th><th>Issue</th><th>Status</th></tr></thead><tbody>"+(rows||"<tr><td colspan=4>None</td></tr>")+"</tbody></table>";
    });
  }

  function loadInvoices(){
    return fetchJson("/api/admin/invoices").then(function(d){
      var rows = (d.invoices||[]).map(function(i){
        return "<tr><td>"+esc(i.number||i.invoice_number||"—")+"</td><td>"+esc(i.client_name||i.owner||"—")+"</td><td>"+esc(String(i.balance_due!=null?i.balance_due:i.total||""))+"</td><td>"+esc(i.status||"—")+"</td></tr>";
      }).join("");
      document.getElementById("panel-invoices").innerHTML = "<h3>Invoice status</h3><table><thead><tr><th>Number</th><th>Client</th><th>Balance</th><th>Status</th></tr></thead><tbody>"+(rows||"<tr><td colspan=4>None</td></tr>")+"</tbody></table>";
    });
  }

  function loadOutbox(){
    return fetchJson("/api/admin/outbox").then(function(d){
      var rows = (d.messages||d.items||[]).map(function(m){
        return "<tr><td>"+esc(m.phone)+"</td><td>"+esc(m.message||"").slice(0,80)+"</td><td>"+(m.delivered?"sent":"pending")+"</td></tr>";
      }).join("");
      document.getElementById("panel-outbox").innerHTML = "<h3>Outbox ("+(d.pending||0)+" pending)</h3><div class=\"row\"><input id=\"ob-phone\" placeholder=\"2782…\" style=\"flex:1\"/><textarea id=\"ob-msg\" rows=\"2\" style=\"flex:2\"></textarea><button type=\"button\" class=\"btn btn-primary\" data-act=\"queue-outbox\">Queue</button></div><table><thead><tr><th>Phone</th><th>Message</th><th>Status</th></tr></thead><tbody>"+(rows||"<tr><td colspan=3>Empty</td></tr>")+"</tbody></table>";
    });
  }

  function loadSystem(){
    return fetchJson("/health").then(function(h){
      var g = h.git || {};
      document.getElementById("panel-system").innerHTML =
        "<h3>System health</h3>"+
        "<div class=\"stat-grid\">"+
        "<div class=\"stat\"><div class=\"l\">Version</div><div class=\"v\" style=\"font-size:1rem\">"+esc(h.version||"?")+"</div></div>"+
        "<div class=\"stat\"><div class=\"l\">Users in memory</div><div class=\"v\">"+(h.users||0)+"</div></div>"+
        "<div class=\"stat\"><div class=\"l\">Git enabled</div><div class=\"v\" style=\"font-size:1rem\">"+(g.enabled?"Yes":"No")+"</div></div>"+
        "<div class=\"stat\"><div class=\"l\">Pushes / pulls</div><div class=\"v\" style=\"font-size:1rem\">"+(g.pushes||0)+" / "+(g.pulls||0)+"</div></div>"+
        "</div>"+
        "<h4>Git durability</h4>"+
        "<table><tbody>"+
        "<tr><td>Last commit</td><td><code>"+esc(g.lastCommit||"—")+"</code></td></tr>"+
        "<tr><td>Last pull</td><td>"+esc(g.lastPullAt||"—")+"</td></tr>"+
        "<tr><td>Last push</td><td>"+esc(g.lastPushAt||"—")+"</td></tr>"+
        "<tr><td>Error</td><td>"+(g.error?"<span class=\"pill bad\">"+esc(String(g.error).slice(0,120))+"</span>":"<span class=\"pill ok\">none</span>")+"</td></tr>"+
        "<tr><td>Server time</td><td>"+esc(h.ts||"—")+"</td></tr>"+
        "</tbody></table>"+
        "<p class=\"sub\">Data survives Render free-tier disk wipes via private GitHub repo <code>saip-sync-data</code>.</p>";
    });
  }

  function loadSecrets(){
    return fetchJson("/api/admin/config").then(function(d){
      document.getElementById("panel-secrets").innerHTML =
        "<h3>Configuration</h3>" +
        "<p class=\"sub\">Public values are served to the app via <code>GET /api/config/app</code>.</p>" +
        "<label class=\"sub\">Public JSON</label>" +
        "<textarea id=\"pub-cfg\" rows=\"6\">"+esc(JSON.stringify(d.public||{},null,2))+"</textarea>" +
        "<div class=\"row\"><button type=\"button\" class=\"btn btn-primary\" data-act=\"save-public\">Save public config</button></div>" +
        "<label class=\"sub\">Set status_api_token</label>" +
        "<input id=\"sec-status\" type=\"password\" placeholder=\"new token\"/>" +
        "<div class=\"row\"><button type=\"button\" class=\"btn-ok\" data-act=\"save-secret-status\">Save status token</button></div>";
    }).catch(function(e){
      document.getElementById("panel-secrets").innerHTML = "<h3>Configuration</h3><p class=\"sub\">"+esc(e.message)+"</p>";
    });
  }

  function loadTools(){
    document.getElementById("panel-tools").innerHTML =
      "<div class=\"row\"><input id=\"tool-phone\" placeholder=\"082…\" style=\"flex:1\"/><button type=\"button\" class=\"btn btn-primary\" data-act=\"lookup\">Lookup</button></div>" +
      "<pre id=\"tool-out\" class=\"sub\" style=\"white-space:pre-wrap;margin-top:12px\"></pre>" +
      "<div class=\"row\" style=\"margin-top:12px\"><input id=\"force-phone\" placeholder=\"Phone\" style=\"flex:1\"/><input id=\"force-name\" placeholder=\"Name\" style=\"flex:1\"/><button type=\"button\" class=\"btn-ok\" data-act=\"force-reg\">Force register</button></div>";
  }

  document.body.addEventListener("click", function(e){
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    if (act === "reset-pw") {
      var id = btn.getAttribute("data-id");
      if (!confirm("Generate a temporary password for this user?")) return;
      fetchJson("/api/admin/users/" + encodeURIComponent(id) + "/reset-password", { method: "POST", body: {} })
        .then(function(d){ toast("Temp password: " + (d.temporary_password || "?")); })
        .catch(function(err){ toast(err.message); });
    }
    if (act === "make-admin") {
      var id2 = btn.getAttribute("data-id");
      fetchJson("/api/admin/users/" + encodeURIComponent(id2), { method: "PATCH", body: { role: "admin" } })
        .then(function(){ toast("Promoted to admin"); loadUsers(); })
        .catch(function(err){ toast(err.message); });
    }
    if (act === "del-user") {
      var id3 = btn.getAttribute("data-id");
      if (!confirm("Delete this user?")) return;
      fetchJson("/api/admin/users/" + encodeURIComponent(id3), { method: "DELETE" })
        .then(function(){ toast("Deleted"); loadUsers(); })
        .catch(function(err){ toast(err.message); });
    }
    if (act === "delwa") {
      var phone = btn.getAttribute("data-phone");
      fetchJson("/api/admin/wa-clients/" + encodeURIComponent(phone), { method: "DELETE" })
        .then(function(){ toast("Removed"); loadWa(); })
        .catch(function(err){ toast(err.message); });
    }
    if (act === "force-wa") {
      var phone2 = btn.getAttribute("data-phone");
      fetchJson("/api/admin/wa-clients/" + encodeURIComponent(phone2) + "/force-register", { method: "POST", body: {} })
        .then(function(){ toast("Marked registered"); loadWa(); })
        .catch(function(err){ toast(err.message); });
    }
    if (act === "queue-outbox") {
      var p = document.getElementById("ob-phone").value;
      var m = document.getElementById("ob-msg").value;
      fetchJson("/api/admin/outbox/queue", { method: "POST", body: { phone: p, message: m } })
        .then(function(){ toast("Queued"); loadOutbox(); })
        .catch(function(err){ toast(err.message); });
    }
    if (act === "save-public") {
      try {
        var pub = JSON.parse(document.getElementById("pub-cfg").value);
        fetchJson("/api/admin/config", { method: "PUT", body: { public: pub } })
          .then(function(){ toast("Public config saved"); }).catch(function(err){ toast(err.message); });
      } catch (err) { toast("Invalid JSON"); }
    }
    if (act === "save-secret-status") {
      var val = document.getElementById("sec-status").value;
      fetchJson("/api/admin/config/secrets", { method: "PUT", body: { status_api_token: val } })
        .then(function(){ toast("Status token saved"); }).catch(function(err){ toast(err.message); });
    }
    if (act === "lookup") {
      var ph = document.getElementById("tool-phone").value;
      fetchJson("/api/admin/lookup?phone=" + encodeURIComponent(ph))
        .then(function(d){ document.getElementById("tool-out").textContent = JSON.stringify(d, null, 2); })
        .catch(function(err){ toast(err.message); });
    }
    if (act === "force-reg") {
      var fp = document.getElementById("force-phone").value;
      var fn = document.getElementById("force-name").value;
      fetchJson("/api/admin/wa-clients/" + encodeURIComponent(fp) + "/force-register", { method: "POST", body: { name: fn } })
        .then(function(){ toast("Force registered"); }).catch(function(err){ toast(err.message); });
    }
  });

  // Session restore
  if (token) {
    fetchJson("/api/admin/me").then(function(d){
      document.getElementById("who").textContent = (d.admin && d.admin.email) || "admin";
      showApp();
    }).catch(function(){
      token = "";
      localStorage.removeItem("saip_admin_token");
    });
  }
})();
