(function(){
  var token = localStorage.getItem("saip_admin_token") || "";
  var DEFAULT_EMAIL = "admin@sainvoice.pro";
  var DEFAULT_PASS = "Admin@SAIP2026!";

  function toast(m){
    var e = document.getElementById("toast");
    e.textContent = m;
    e.style.display = "block";
    setTimeout(function(){ e.style.display = "none"; }, 4500);
  }
  function showErr(m){ document.getElementById("login-err").textContent = m || ""; }
  function esc(s){
    return String(s == null ? "" : s)
      .replace(/&/g,"&").replace(/</g,"<").replace(/>/g,">").replace(/"/g,""");
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
        showErr("Server waking up (Render free tier)… retry " + (attempt + 1) + "/3");
        return new Promise(function(resolve){ setTimeout(resolve, 2500 * attempt); })
          .then(function(){ return fetchJson(path, opts, attempt + 1); });
      }
      if (isNet) throw new Error("Network interrupted — click Wake server, wait 20s, then sign in again.");
      throw err;
    });
  }

  function showApp(){
    document.getElementById("login").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    loadDash().catch(function(e){ toast(e.message); });
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
      toast("Signed in");
    }).catch(function(e){
      var msg = (e && e.message) ? e.message : String(e);
      if (/Invalid email or password/i.test(msg)) {
        msg = "Invalid password. Use default credentials or your ADMIN_PASSWORD.";
      } else if (/Admin access required/i.test(msg)) {
        msg = "Logged in but not admin. Use admin@sainvoice.pro";
      }
      showErr(msg);
      document.getElementById("login-hint").textContent = "Tip: Wake server → wait → Use default → Sign in.";
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
    toast("Default credentials filled — click Sign in");
  };
  document.getElementById("btn-login").onclick = doLogin;
  document.getElementById("btn-wake").onclick = function(){
    showErr("Waking server…");
    fetchJson("/health").then(function(h){
      showErr("");
      toast("Server online · v" + (h.version || "?"));
    }).catch(function(e){ showErr(e.message); });
  };
  document.getElementById("password").addEventListener("keydown", function(e){ if (e.key === "Enter") doLogin(); });
  document.getElementById("email").addEventListener("keydown", function(e){ if (e.key === "Enter") doLogin(); });
  document.getElementById("btn-logout").onclick = function(){
    token = "";
    localStorage.removeItem("saip_admin_token");
    location.reload();
  };

  document.querySelectorAll("[data-tab]").forEach(function(b){
    b.onclick = function(){
      document.querySelectorAll("[data-tab]").forEach(function(x){ x.classList.remove("on"); });
      b.classList.add("on");
      var tab = b.getAttribute("data-tab");
      ["dash","wa","tickets","invoices","outbox","users","secrets","tools"].forEach(function(n){
        var el = document.getElementById("panel-" + n);
        if (el) el.classList.toggle("hidden", n !== tab);
      });
      if (tab === "dash") loadDash().catch(function(e){ toast(e.message); });
      if (tab === "wa") loadWa().catch(function(e){ toast(e.message); });
      if (tab === "tickets") loadTickets().catch(function(e){ toast(e.message); });
      if (tab === "invoices") loadInvoices().catch(function(e){ toast(e.message); });
      if (tab === "outbox") loadOutbox().catch(function(e){ toast(e.message); });
      if (tab === "users") loadUsers().catch(function(e){ toast(e.message); });
      if (tab === "secrets") loadSecrets().catch(function(e){ toast(e.message); });
      if (tab === "tools") loadTools();
    };
  });

  function loadDash(){
    return fetchJson("/api/admin/stats").then(function(d){
      var s = d.stats || {};
      document.getElementById("panel-dash").innerHTML =
        "<h3>Overview</h3>" +
        "<div class=\"stat-grid\">" +
        "<div class=\"stat\"><div class=\"l\">Users</div><div class=\"v\">"+(s.users||0)+"</div></div>" +
        "<div class=\"stat\"><div class=\"l\">WA clients</div><div class=\"v\">"+(s.wa_clients||0)+"</div></div>" +
        "<div class=\"stat\"><div class=\"l\">Registered</div><div class=\"v\">"+(s.wa_registered||0)+"</div></div>" +
        "<div class=\"stat\"><div class=\"l\">Pending import</div><div class=\"v\">"+(s.wa_pending_import||0)+"</div></div>" +
        "<div class=\"stat\"><div class=\"l\">Tickets</div><div class=\"v\">"+(s.tickets_total||0)+"</div></div>" +
        "<div class=\"stat\"><div class=\"l\">Outbox</div><div class=\"v\">"+(s.outbox_pending||0)+"</div></div>" +
        "</div>" +
        "<p class=\"sub\"><a href=\"/api/config/app\" target=\"_blank\" rel=\"noopener\">Live config</a> · <a href=\"/health\" target=\"_blank\" rel=\"noopener\">Health</a></p>";
    });
  }
  function loadWa(){
    return fetchJson("/api/admin/wa-clients").then(function(d){
      var rows = (d.clients||[]).map(function(c){
        var phone = esc(c.phone);
        return "<tr><td>"+esc(c.name||"—")+"<div style=\"color:var(--muted);font-size:.75rem\">"+phone+"</div></td><td>"+esc(c.email||"—")+"</td><td>"+(c.registered?"<span class=\"pill ok\">yes</span>":"<span class=\"pill\">no</span>")+"</td><td class=\"row\">"+(c.registered?"":"<button type=\"button\" class=\"btn-ok\" data-act=\"force-wa\" data-phone=\""+phone+"\">Mark reg</button>")+"<button type=\"button\" class=\"btn-danger\" data-act=\"delwa\" data-phone=\""+phone+"\">Remove</button></td></tr>";
      }).join("");
      document.getElementById("panel-wa").innerHTML = "<h3>WhatsApp clients ("+(d.count||0)+")</h3><table><thead><tr><th>Client</th><th>Email</th><th>Reg</th><th>Actions</th></tr></thead><tbody>"+(rows||"<tr><td colspan=4>None yet</td></tr>")+"</tbody></table>";
    });
  }
  function loadTickets(){
    return fetchJson("/api/admin/tickets").then(function(d){
      var rows = (d.tickets||[]).map(function(t){
        return "<tr><td>"+esc(t.customer_name||"—")+"</td><td>"+esc(t.device||"—")+"</td><td>"+esc(t.issue||"—")+"</td><td>"+esc(t.status||"new")+"</td></tr>";
      }).join("");
      document.getElementById("panel-tickets").innerHTML = "<h3>Intake tickets</h3><table><thead><tr><th>Customer</th><th>Device</th><th>Issue</th><th>Status</th></tr></thead><tbody>"+(rows||"<tr><td colspan=4>None</td></tr>")+"</tbody></table>";
    });
  }
  function loadInvoices(){
    return fetchJson("/api/admin/invoices").then(function(d){
      var rows = (d.invoices||[]).map(function(i){
        return "<tr><td>"+esc(i.invoice_number)+"</td><td>"+esc(i.client_name||"—")+"</td><td>R"+Number(i.balance_due!=null?i.balance_due:i.total||0).toFixed(2)+"</td><td>"+esc(i.status)+"</td></tr>";
      }).join("");
      document.getElementById("panel-invoices").innerHTML = "<h3>Invoice status</h3><table><thead><tr><th>Number</th><th>Client</th><th>Balance</th><th>Status</th></tr></thead><tbody>"+(rows||"<tr><td colspan=4>None</td></tr>")+"</tbody></table>";
    });
  }
  function loadOutbox(){
    return fetchJson("/api/admin/outbox").then(function(d){
      var rows = (d.messages||[]).map(function(m){
        return "<tr><td>"+esc(m.phone)+"</td><td>"+esc((m.message||"").slice(0,120))+"</td><td>"+(m.delivered?"sent":"pending")+"</td></tr>";
      }).join("");
      document.getElementById("panel-outbox").innerHTML = "<h3>Outbox ("+(d.pending||0)+" pending)</h3><div class=\"row\"><input id=\"ob-phone\" placeholder=\"2782…\" style=\"flex:1\"/><textarea id=\"ob-msg\" rows=\"2\" style=\"flex:2\"></textarea><button type=\"button\" class=\"btn btn-primary\" data-act=\"queue-outbox\">Queue</button></div><table><thead><tr><th>Phone</th><th>Message</th><th>Status</th></tr></thead><tbody>"+(rows||"<tr><td colspan=3>Empty</td></tr>")+"</tbody></table>";
    });
  }
  function loadUsers(){
    return fetchJson("/api/admin/users").then(function(d){
      var rows = (d.users||[]).map(function(u){
        return "<tr><td>"+esc(u.email)+"</td><td>"+esc(u.name||"—")+"</td><td>"+esc(u.role)+"</td><td>"+(u.has_workspace?"v"+u.workspace_version:"—")+"</td></tr>";
      }).join("");
      document.getElementById("panel-users").innerHTML = "<h3>Users ("+(d.count||0)+")</h3><table><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Workspace</th></tr></thead><tbody>"+(rows||"")+"</tbody></table>";
    });
  }
  function loadSecrets(){
    return fetchJson("/api/admin/config").then(function(d){
      var pub = d.public || {};
      var secrets = d.secrets || {};
      var secretRows = Object.keys(secrets).map(function(k){
        var s = secrets[k] || {};
        return "<tr><td><code>"+esc(k)+"</code></td><td>"+(s.set?"<span class=\"pill ok\">set ("+s.length+")</span>":"<span class=\"pill\">empty</span>")+"</td></tr>";
      }).join("");
      document.getElementById("panel-secrets").innerHTML =
        "<h3>Configuration</h3>" +
        "<p class=\"sub\">Public values are served to the app via <code>GET /api/config/app</code>.</p>" +
        "<label class=\"sub\">Google Client ID</label>" +
        "<input id=\"cfg-gci\" value=\""+esc(pub.google_client_id||"")+"\" placeholder=\"xxxx.apps.googleusercontent.com\"/>" +
        "<label class=\"sub\">Announcement</label>" +
        "<input id=\"cfg-ann\" value=\""+esc(pub.announcement||"")+"\"/>" +
        "<div class=\"row\"><button type=\"button\" class=\"btn btn-primary\" data-act=\"save-public\">Save public config</button></div>" +
        "<h4>Secrets (masked)</h4>" +
        "<table><thead><tr><th>Key</th><th>Status</th></tr></thead><tbody>"+(secretRows||"<tr><td colspan=2>None</td></tr>")+"</tbody></table>" +
        "<label class=\"sub\">Set status_api_token</label>" +
        "<input id=\"sec-status\" type=\"password\" placeholder=\"new token\"/>" +
        "<div class=\"row\"><button type=\"button\" class=\"btn-ok\" data-act=\"save-secret-status\">Save status token</button></div>";
    }).catch(function(e){
      document.getElementById("panel-secrets").innerHTML = "<h3>Configuration</h3><p class=\"sub\">"+esc(e.message)+"</p><p class=\"sub\">Config API may not be mounted on this deploy.</p>";
    });
  }
  function loadTools(){
    document.getElementById("panel-tools").innerHTML =
      "<h3>Tools</h3>" +
      "<p class=\"sub\">Lookup a WhatsApp number or force-register a client.</p>" +
      "<div class=\"row\"><input id=\"tool-phone\" placeholder=\"082…\" style=\"flex:1\"/><button type=\"button\" class=\"btn btn-primary\" data-act=\"lookup\">Lookup</button></div>" +
      "<div id=\"tool-result\" class=\"sub\"></div>" +
      "<div class=\"row\" style=\"margin-top:12px\"><input id=\"force-phone\" placeholder=\"Phone\" style=\"flex:1\"/><input id=\"force-name\" placeholder=\"Name\" style=\"flex:1\"/><button type=\"button\" class=\"btn-ok\" data-act=\"force-reg\">Force register</button></div>";
  }

  document.body.addEventListener("click", function(e){
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    if (act === "delwa") {
      var phone = btn.getAttribute("data-phone");
      if (!confirm("Remove WA client " + phone + "?")) return;
      fetchJson("/api/admin/wa-clients/" + encodeURIComponent(phone), { method: "DELETE" })
        .then(function(){ toast("Removed"); return loadWa(); })
        .catch(function(err){ toast(err.message); });
    }
    if (act === "force-wa") {
      var phone2 = btn.getAttribute("data-phone");
      fetchJson("/api/admin/wa-clients/" + encodeURIComponent(phone2) + "/force-register", { method: "POST", body: {} })
        .then(function(){ toast("Marked registered"); return loadWa(); })
        .catch(function(err){ toast(err.message); });
    }
    if (act === "queue-outbox") {
      var p = (document.getElementById("ob-phone") || {}).value;
      var m = (document.getElementById("ob-msg") || {}).value;
      fetchJson("/api/admin/outbox/queue", { method: "POST", body: { phone: p, message: m } })
        .then(function(){ toast("Queued"); return loadOutbox(); })
        .catch(function(err){ toast(err.message); });
    }
    if (act === "save-public") {
      fetchJson("/api/admin/config", {
        method: "PUT",
        body: {
          public: {
            google_client_id: (document.getElementById("cfg-gci") || {}).value,
            announcement: (document.getElementById("cfg-ann") || {}).value
          }
        }
      }).then(function(){ toast("Public config saved"); }).catch(function(err){ toast(err.message); });
    }
    if (act === "save-secret-status") {
      var val = (document.getElementById("sec-status") || {}).value;
      fetchJson("/api/admin/config/secrets", { method: "PUT", body: { status_api_token: val } })
        .then(function(){ toast("Secret saved"); return loadSecrets(); })
        .catch(function(err){ toast(err.message); });
    }
    if (act === "lookup") {
      var ph = (document.getElementById("tool-phone") || {}).value;
      fetchJson("/api/admin/lookup?phone=" + encodeURIComponent(ph))
        .then(function(d){
          document.getElementById("tool-result").textContent = JSON.stringify(d, null, 2);
        }).catch(function(err){ toast(err.message); });
    }
    if (act === "force-reg") {
      var fp = (document.getElementById("force-phone") || {}).value;
      var fn = (document.getElementById("force-name") || {}).value;
      fetchJson("/api/admin/wa-clients/" + encodeURIComponent(fp) + "/force-register", {
        method: "POST", body: { name: fn }
      }).then(function(){ toast("Force registered"); }).catch(function(err){ toast(err.message); });
    }
  });

  if (token) {
    fetchJson("/api/admin/me").then(function(d){
      document.getElementById("who").textContent = (d.admin && d.admin.email) || "";
      showApp();
    }).catch(function(){
      localStorage.removeItem("saip_admin_token");
      token = "";
    });
  }
})();
