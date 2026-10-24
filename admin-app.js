(function(){
  var token = localStorage.getItem("saip_admin_token") || "";
  var DEFAULT_EMAIL = "admin@sainvoice.pro";
  var DEFAULT_PASS = "Admin@SAIP2026!";
  var currentTab = "dash";
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem("saip_admin_theme", t);
    var label = t === "light" ? "Dark mode" : "Light mode";
    ["btn-theme","btn-theme-login","btn-theme-m"].forEach(function(id){
      var el = document.getElementById(id); if (el) el.textContent = label;
    });
  }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(cur === "dark" ? "light" : "dark");
  }
  applyTheme(localStorage.getItem("saip_admin_theme") || "dark");
  function toast(m){
    var e = document.getElementById("toast");
    if (!e) return;
    e.textContent = m; e.style.display = "block";
    setTimeout(function(){ e.style.display = "none"; }, 4200);
  }
  function showErr(m){ var e=document.getElementById("login-err"); if(e) e.textContent = m||""; }
  function esc(s){
    return String(s==null?"":s).replace(/&/g,"&").replace(/</g,"<").replace(/>/g,">").replace(/"/g,""");
  }
  function money(n){
    var x=Number(n); if(!isFinite(x)) return "—";
    try{return "R "+x.toLocaleString("en-ZA",{minimumFractionDigits:2,maximumFractionDigits:2});}catch(_){return "R "+x.toFixed(2);}
  }
  function fetchJson(path, opts, attempt){
    attempt=attempt||1; opts=opts||{};
    var headers={"Content-Type":"application/json","Accept":"application/json"};
    if(token) headers.Authorization="Bearer "+token;
    var ctrl=typeof AbortController!=="undefined"?new AbortController():null;
    var timer=setTimeout(function(){try{ctrl&&ctrl.abort();}catch(e){}},55000);
    return fetch(path,{method:opts.method||"GET",headers:headers,body:opts.body?JSON.stringify(opts.body):undefined,signal:ctrl?ctrl.signal:undefined,credentials:"same-origin"})
    .then(function(r){clearTimeout(timer);return r.text().then(function(txt){var data={};try{data=txt?JSON.parse(txt):{};}catch(e){data={error:txt||r.statusText};}if(!r.ok)throw new Error(data.error||data.message||("HTTP "+r.status));return data;});})
    .catch(function(err){clearTimeout(timer);var msg=(err&&err.message)?err.message:String(err);var isNet=/abort|Failed to fetch|NetworkError|network|timeout|interrupted/i.test(msg);if(isNet&&attempt<3){showErr("Server waking… retry "+(attempt+1)+"/3");return new Promise(function(r){setTimeout(r,2500*attempt);}).then(function(){return fetchJson(path,opts,attempt+1);});}if(isNet)throw new Error("Network interrupted — wake server, wait 20s, sign in.");throw err;});
  }
  function closeDrawer(){var d=document.getElementById("drawer"),b=document.getElementById("drawer-backdrop");if(d)d.classList.remove("open");if(b)b.classList.remove("show");}
  function openDrawer(){var d=document.getElementById("drawer"),b=document.getElementById("drawer-backdrop");if(d)d.classList.add("open");if(b)b.classList.add("show");}
  var TITLES={dash:["Dashboard","Users & workspaces"],users:["Users","Cloud accounts"],invoices:["Invoices","All workspaces"],tickets:["Tickets","Job cards"],clients:["Clients","All workspaces"],system:["System","Git & health"],secrets:["Config","Public config"],tools:["Tools","Lookup"],wa:["WhatsApp","Clients"],outbox:["Outbox","Messages"]};
  function setPage(tab){
    currentTab=tab;var t=TITLES[tab]||[tab,""];
    var pt=document.getElementById("page-title"),ps=document.getElementById("page-sub");
    if(pt)pt.textContent=t[0];if(ps)ps.textContent=t[1];
    ["dash","users","invoices","tickets","clients","system","secrets","tools","wa","outbox"].forEach(function(n){var el=document.getElementById("panel-"+n);if(el)el.classList.toggle("hidden",n!==tab);});
    document.querySelectorAll("[data-tab]").forEach(function(b){
      var bt=b.getAttribute("data-tab");
      if(b.classList.contains("bnav")){
        if(bt==="more") b.classList.toggle("on",["clients","system","secrets","tools","wa","outbox"].indexOf(tab)>=0);
        else b.classList.toggle("on",bt===tab);
      } else if(b.classList.contains("tab")) b.classList.toggle("on",bt===tab);
    });
  }
  function goTab(tab){
    if(tab==="more"){openDrawer();return;}
    closeDrawer();setPage(tab);
    var loaders={dash:loadDash,users:loadUsers,invoices:loadInvoices,tickets:loadTickets,clients:loadClients,system:loadSystem,secrets:loadSecrets,tools:loadTools,wa:loadWa,outbox:loadOutbox};
    if(loaders[tab]) loaders[tab]().catch(function(e){toast(e.message);});
  }
  function showApp(){
    document.getElementById("login").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    refreshGitBadge();goTab("dash");
  }
  function refreshGitBadge(){
    fetchJson("/health").then(function(h){
      var g=(h&&h.git)||{},el=document.getElementById("git-badge");if(!el)return;
      var on=!!g.enabled&&!g.error;
      el.innerHTML='<span class="dot '+(on?"on":"off")+'"></span>Git '+(g.enabled?(g.error?"error":"connected"):"off")+(g.lastCommit?" · "+esc(g.lastCommit):"");
    }).catch(function(){});
  }
  function doLogin(){
    showErr("");var hint=document.getElementById("login-hint");if(hint)hint.textContent="";
    var email=document.getElementById("email").value.trim();
    var password=document.getElementById("password").value;
    if(!email||!password){showErr("Enter email and password.");return;}
    var btn=document.getElementById("btn-login");btn.disabled=true;btn.textContent="Signing in…";
    fetchJson("/health").catch(function(){return null;}).then(function(){
      return fetchJson("/api/auth/login",{method:"POST",body:{email:email,password:password}});
    }).then(function(d){
      if(!d||!d.token)throw new Error("No token returned");
      token=d.token;localStorage.setItem("saip_admin_token",token);
      return fetchJson("/api/admin/me");
    }).then(function(me){
      var who=(me.admin&&me.admin.email)||email;
      var w=document.getElementById("who");if(w)w.textContent=who;
      var wm=document.getElementById("who-m");if(wm)wm.textContent=who;
      showApp();toast("Signed in as administrator");
    }).catch(function(e){
      var msg=(e&&e.message)?e.message:String(e);
      if(/Invalid email or password/i.test(msg))msg="Invalid credentials. Try Use default.";
      else if(/Admin access required/i.test(msg))msg="Account is not admin. Use admin@sainvoice.pro";
      showErr(msg);if(hint)hint.textContent="Tip: Wake server → Use default → Sign in.";
      localStorage.removeItem("saip_admin_token");token="";
    }).finally(function(){btn.disabled=false;btn.textContent="Sign in";});
  }
  function bind(id,fn){var el=document.getElementById(id);if(el)el.onclick=fn;}
  bind("btn-fill",function(){document.getElementById("email").value=DEFAULT_EMAIL;document.getElementById("password").value=DEFAULT_PASS;showErr("");toast("Default credentials filled");});
  bind("btn-login",doLogin);
  bind("btn-wake",function(){showErr("Waking…");fetchJson("/health").then(function(h){showErr("");toast("Online · v"+(h.version||"?")+" · users "+(h.users||0));}).catch(function(e){showErr(e.message);});});
  ["password","email"].forEach(function(id){var el=document.getElementById(id);if(el)el.addEventListener("keydown",function(e){if(e.key==="Enter")doLogin();});});
  function logout(){token="";localStorage.removeItem("saip_admin_token");location.reload();}
  bind("btn-logout",logout);bind("btn-logout-m",logout);
  bind("btn-theme",toggleTheme);bind("btn-theme-login",toggleTheme);bind("btn-theme-m",toggleTheme);
  function refreshCurrent(){goTab(currentTab);refreshGitBadge();}
  bind("btn-refresh",refreshCurrent);bind("btn-refresh-m",refreshCurrent);
  document.querySelectorAll("[data-tab]").forEach(function(btn){btn.addEventListener("click",function(){goTab(btn.getAttribute("data-tab"));});});
  var bd=document.getElementById("drawer-backdrop");if(bd)bd.onclick=closeDrawer;

  function loadDash(){
    return Promise.all([fetchJson("/api/admin/stats"),fetchJson("/health")]).then(function(arr){
      var s=(arr[0].stats)||{},g=(arr[1]&&arr[1].git)||{};
      document.getElementById("panel-dash").innerHTML=
        "<div class=\"stat-grid\">"+
        "<div class=\"stat\"><div class=\"l\">Users</div><div class=\"v\">"+(s.users||0)+"</div></div>"+
        "<div class=\"stat\"><div class=\"l\">Workspaces</div><div class=\"v\">"+(s.workspaces||0)+"</div></div>"+
        "<div class=\"stat\"><div class=\"l\">Invoices</div><div class=\"v\">"+(s.invoices||0)+"</div></div>"+
        "<div class=\"stat\"><div class=\"l\">Clients</div><div class=\"v\">"+(s.clients||0)+"</div></div>"+
        "<div class=\"stat\"><div class=\"l\">Tickets</div><div class=\"v\">"+(s.tickets||0)+"</div></div>"+
        "<div class=\"stat\"><div class=\"l\">Open AR</div><div class=\"v\" style=\"font-size:1rem\">"+money(s.outstanding_ar||0)+"</div></div></div>"+
        "<div class=\"card\"><h3>Git</h3><p class=\"hint\">"+(g.enabled?"Connected":"Off")+" · pushes "+(g.pushes||0)+
        (g.lastPushAt?" · "+esc(g.lastPushAt):"")+"</p>"+
        "<button type=\"button\" class=\"btn btn-primary btn-sm\" id=\"btn-git-flush\">Flush git</button></div>";
      var gf=document.getElementById("btn-git-flush");
      if(gf)gf.onclick=function(){fetchJson("/api/admin/git-flush",{method:"POST",body:{}}).then(function(){toast("Git flush ok");refreshGitBadge();}).catch(function(e){toast(e.message);});};
    });
  }
  function loadUsers(){
    return fetchJson("/api/admin/users").then(function(d){
      var users=d.users||[];
      var rows=users.map(function(u){return "<tr><td>"+esc(u.email)+"</td><td>"+esc(u.role||"user")+"</td><td>"+(u.has_workspace?"yes":"no")+"</td><td class=\"row\">"+
        "<button type=\"button\" class=\"btn-ok btn-sm\" data-act=\"reset-pw\" data-id=\""+esc(u.id)+"\">Reset PW</button>"+
        (u.role==="admin"?"":"<button type=\"button\" class=\"btn-outline btn-sm\" data-act=\"make-admin\" data-id=\""+esc(u.id)+"\">Admin</button>")+
        "<button type=\"button\" class=\"btn-danger btn-sm\" data-act=\"del-user\" data-id=\""+esc(u.id)+"\">Del</button></td></tr>";}).join("");
      var cards=users.map(function(u){return "<div class=\"m-card\"><div class=\"t\">"+esc(u.email)+"</div><div class=\"s\">"+esc(u.role)+" · ws "+(u.has_workspace?"yes":"no")+"</div><div class=\"acts\">"+
        "<button type=\"button\" class=\"btn-ok btn-sm\" data-act=\"reset-pw\" data-id=\""+esc(u.id)+"\">Reset</button>"+
        (u.role==="admin"?"":"<button type=\"button\" class=\"btn-outline btn-sm\" data-act=\"make-admin\" data-id=\""+esc(u.id)+"\">Admin</button>")+
        "<button type=\"button\" class=\"btn-danger btn-sm\" data-act=\"del-user\" data-id=\""+esc(u.id)+"\">Del</button></div></div>";}).join("");
      document.getElementById("panel-users").innerHTML="<table class=\"desktop-table\"><thead><tr><th>Email</th><th>Role</th><th>WS</th><th></th></tr></thead><tbody>"+(rows||"<tr><td colspan=4>None</td></tr>")+"</tbody></table><div class=\"mobile-list m-list\">"+(cards||"")+"</div>";
    });
  }
  function loadInvoices(){
    return fetchJson("/api/admin/invoices").then(function(d){
      var list=d.invoices||[];
      var rows=list.map(function(i){return "<tr><td>"+esc(i.number||"—")+"</td><td>"+esc(i.client_name||"—")+"</td><td>"+money(i.balance_due!=null?i.balance_due:i.total)+"</td><td>"+esc(i.status||"—")+"</td><td>"+esc(i.owner_email||"")+"</td></tr>";}).join("");
      var cards=list.map(function(i){return "<div class=\"m-card\"><div class=\"t\">"+esc(i.number||"INV")+" · "+money(i.total)+"</div><div class=\"s\">"+esc(i.client_name||"—")+" · "+esc(i.status||"")+" · "+esc(i.owner_email||"")+"</div></div>";}).join("");
      document.getElementById("panel-invoices").innerHTML="<div class=\"card\"><strong>"+list.length+"</strong> invoices</div><table class=\"desktop-table\"><thead><tr><th>#</th><th>Client</th><th>Bal</th><th>Status</th><th>Owner</th></tr></thead><tbody>"+(rows||"<tr><td colspan=5>None — users must Sync Now</td></tr>")+"</tbody></table><div class=\"mobile-list m-list\">"+(cards||"<p class=\"hint\">None</p>")+"</div>";
    });
  }
  function loadTickets(){
    return fetchJson("/api/admin/tickets").then(function(d){
      var list=d.tickets||[];
      var rows=list.map(function(t){return "<tr><td>"+esc(t.customer_name||t.title||"—")+"</td><td>"+esc((t.issue||"").toString().slice(0,60))+"</td><td>"+esc(t.status||"open")+"</td><td>"+esc(t.owner_email||"")+"</td></tr>";}).join("");
      var cards=list.map(function(t){return "<div class=\"m-card\"><div class=\"t\">"+esc(t.customer_name||t.title||"Ticket")+"</div><div class=\"s\">"+esc(t.status||"open")+" · "+esc(t.owner_email||"")+"</div></div>";}).join("");
      document.getElementById("panel-tickets").innerHTML="<div class=\"card\"><strong>"+list.length+"</strong> tickets</div><table class=\"desktop-table\"><thead><tr><th>Customer</th><th>Issue</th><th>Status</th><th>Owner</th></tr></thead><tbody>"+(rows||"<tr><td colspan=4>None</td></tr>")+"</tbody></table><div class=\"mobile-list m-list\">"+(cards||"")+"</div>";
    });
  }
  function loadClients(){
    return fetchJson("/api/admin/clients").then(function(d){
      var list=d.clients||[];
      var rows=list.map(function(c){return "<tr><td>"+esc(c.name||"—")+"</td><td>"+esc(c.email||"—")+"</td><td>"+esc(c.phone||"—")+"</td><td>"+esc(c.owner_email||"")+"</td></tr>";}).join("");
      var cards=list.map(function(c){return "<div class=\"m-card\"><div class=\"t\">"+esc(c.name||"Client")+"</div><div class=\"s\">"+esc(c.email||"—")+" · "+esc(c.phone||"—")+"</div></div>";}).join("");
      document.getElementById("panel-clients").innerHTML="<div class=\"card\"><strong>"+list.length+"</strong> clients</div><table class=\"desktop-table\"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Owner</th></tr></thead><tbody>"+(rows||"<tr><td colspan=4>None</td></tr>")+"</tbody></table><div class=\"mobile-list m-list\">"+(cards||"")+"</div>";
    }).catch(function(e){document.getElementById("panel-clients").innerHTML="<div class=\"card\">"+esc(e.message)+"</div>";});
  }
  function loadSystem(){
    return fetchJson("/health").then(function(h){
      var g=h.git||{};
      document.getElementById("panel-system").innerHTML="<div class=\"stat-grid\"><div class=\"stat\"><div class=\"l\">Version</div><div class=\"v\" style=\"font-size:1rem\">"+esc(h.version||"?")+"</div></div><div class=\"stat\"><div class=\"l\">Users</div><div class=\"v\">"+(h.users||0)+"</div></div><div class=\"stat\"><div class=\"l\">Git</div><div class=\"v\" style=\"font-size:1rem\">"+(g.enabled?"On":"Off")+"</div></div></div><div class=\"card\"><table><tbody><tr><td>Last push</td><td>"+esc(g.lastPushAt||"—")+"</td></tr><tr><td>Error</td><td>"+(g.error?"<span class=\"pill bad\">"+esc(String(g.error).slice(0,100))+"</span>":"<span class=\"pill ok\">none</span>")+"</td></tr></tbody></table></div>";
    });
  }
  function loadSecrets(){
    return fetchJson("/api/admin/config").then(function(d){
      document.getElementById("panel-secrets").innerHTML="<div class=\"card\"><h3>Public config</h3><textarea id=\"pub-cfg\" rows=\"8\">"+esc(JSON.stringify(d.public||{},null,2))+"</textarea><div class=\"row\" style=\"margin-top:10px\"><button type=\"button\" class=\"btn btn-primary\" data-act=\"save-public\">Save</button></div></div>";
    }).catch(function(e){document.getElementById("panel-secrets").innerHTML="<div class=\"card\">"+esc(e.message)+"</div>";});
  }
  function loadTools(){
    document.getElementById("panel-tools").innerHTML="<div class=\"card\"><div class=\"row\"><input id=\"tool-phone\" placeholder=\"Phone\" style=\"flex:1\"/><button type=\"button\" class=\"btn btn-primary\" data-act=\"lookup\">Lookup</button></div><pre id=\"tool-out\" class=\"hint\" style=\"white-space:pre-wrap;margin-top:12px\"></pre></div>";
  }
  function loadWa(){return fetchJson("/api/admin/wa-clients").then(function(d){document.getElementById("panel-wa").innerHTML="<div class=\"card\">"+(d.count||0)+" WA clients</div>";});}
  function loadOutbox(){return fetchJson("/api/admin/outbox").then(function(d){document.getElementById("panel-outbox").innerHTML="<div class=\"card\">"+(d.pending||0)+" pending</div>";});}

  document.body.addEventListener("click",function(e){
    var btn=e.target.closest("[data-act]");if(!btn)return;
    var act=btn.getAttribute("data-act");
    if(act==="reset-pw"){if(!confirm("Temp password?"))return;fetchJson("/api/admin/users/"+encodeURIComponent(btn.getAttribute("data-id"))+"/reset-password",{method:"POST",body:{}}).then(function(d){toast("Temp: "+(d.temporary_password||"?"));}).catch(function(err){toast(err.message);});}
    if(act==="make-admin"){fetchJson("/api/admin/users/"+encodeURIComponent(btn.getAttribute("data-id")),{method:"PATCH",body:{role:"admin"}}).then(function(){toast("Promoted");loadUsers();}).catch(function(err){toast(err.message);});}
    if(act==="del-user"){if(!confirm("Delete user?"))return;fetchJson("/api/admin/users/"+encodeURIComponent(btn.getAttribute("data-id")),{method:"DELETE"}).then(function(){toast("Deleted");loadUsers();}).catch(function(err){toast(err.message);});}
    if(act==="save-public"){try{var pub=JSON.parse(document.getElementById("pub-cfg").value);fetchJson("/api/admin/config",{method:"PUT",body:{public:pub}}).then(function(){toast("Saved");}).catch(function(err){toast(err.message);});}catch(err){toast("Invalid JSON");}}
    if(act==="lookup"){fetchJson("/api/admin/lookup?phone="+encodeURIComponent(document.getElementById("tool-phone").value)).then(function(d){document.getElementById("tool-out").textContent=JSON.stringify(d,null,2);}).catch(function(err){toast(err.message);});}
  });
  if(token){
    fetchJson("/api/admin/me").then(function(d){
      var who=(d.admin&&d.admin.email)||"admin";
      var w=document.getElementById("who");if(w)w.textContent=who;
      var wm=document.getElementById("who-m");if(wm)wm.textContent=who;
      showApp();
    }).catch(function(){token="";localStorage.removeItem("saip_admin_token");});
  }
})();
