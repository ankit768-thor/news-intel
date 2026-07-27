/* News Intelligence Dashboard — frontend (vanilla JS, no build step) */
const App = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const api = (p) => fetch(p).then(r => r.json());
  const esc = (s) => (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Only allow http/https in feed-derived hrefs — blocks javascript:/data: from quirky RSS links.
  const safeUrl = (u) => {
    try { const p = new URL(u, location.origin); return (p.protocol === "http:" || p.protocol === "https:") ? p.href : "#"; }
    catch { return "#"; }
  };
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem("ni_" + k)) ?? d; } catch { return d; } },
    set(k, v) { localStorage.setItem("ni_" + k, JSON.stringify(v)); },
  };
  // Owner is on the local link; visitors come via the public (cloud) link.
  const LOCAL = ["localhost", "127.0.0.1", "0.0.0.0", ""].includes(location.hostname);
  // On a cloud host the owner unlocks owner-only features (Who's Watching) once via
  // /#owner=<token>, stored here and sent with owner requests.
  function ownerToken() { return store.get("owner_token", "") || ""; }
  function isOwner() { return LOCAL || !!ownerToken(); }

  // ---- App state ----
  const state = {
    section: "home",
    meta: null,
    category: null,
    sort: "time",
    hours: null,
    minRel: 0,
    bias: "",
    state_filter: "",
    page: 0,
    size: 30,
    stories: [],
    total: 0,
    loadingMore: false,
    storiesById: {},
    query: "",
  };

  const NAV = [
    { group: "Briefing", items: [
      { id: "home", icon: "🏠", label: "Home" },
      { id: "shorts", icon: "🗞️", label: "In Short" },
      { id: "breaking", icon: "⚡", label: "Breaking" },
      { id: "trending", icon: "📈", label: "Trending" },
      { id: "map", icon: "🗺️", label: "World Map" },
    ]},
    { group: "Feeds", items: [
      { id: "world", icon: "🌍", label: "World" },
      { id: "india", icon: "🇮🇳", label: "India" },
      { id: "local", icon: "📍", label: "Local" },
    ]},
    { group: "Desks", items: [
      { id: "cat:Technology", icon: "💻", label: "Technology" },
      { id: "cat:AI", icon: "🤖", label: "AI" },
      { id: "cat:Business", icon: "💼", label: "Business" },
      { id: "cat:Finance", icon: "📊", label: "Markets" },
      { id: "cat:Science", icon: "🔬", label: "Science" },
      { id: "cat:Space", icon: "🚀", label: "Space" },
      { id: "cat:Sports", icon: "🏆", label: "Sports" },
      { id: "cat:Health", icon: "🩺", label: "Health" },
      { id: "cat:Cryptocurrency", icon: "₿", label: "Crypto" },
    ]},
    { group: "You", items: [
      { id: "alerts", icon: "🔔", label: "News Alerts" },
      { id: "bookmarks", icon: "🔖", label: "Bookmarks" },
      { id: "history", icon: "🕑", label: "History" },
      { id: "visitors", icon: "👁️", label: "Who's Watching", ownerOnly: true },
    ]},
  ];

  // ============================================================== NAV / boot
  function renderNav() {
    const nav = $("#nav");
    nav.innerHTML = NAV.map(g => `
      <div class="nav-group">
        <div class="label">${g.group}</div>
        ${g.items.filter(it => !it.ownerOnly || isOwner()).map(it => `
          <button class="nav-item" data-sec="${it.id}">
            <span class="ic">${it.icon}</span>${it.label}
            ${it.id === "breaking" ? '<span class="badge" id="brkBadge" style="display:none"></span>' : ""}
          </button>`).join("")}
      </div>`).join("");
    nav.addEventListener("click", e => {
      const b = e.target.closest(".nav-item");
      if (b) go(b.dataset.sec);
    });
  }

  const BOTTOM_NAV = [
    { id: "home", icon: "🏠", label: "Home" },
    { id: "shorts", icon: "🗞️", label: "Shorts" },
    { id: "trending", icon: "📈", label: "Trends" },
    { id: "india", icon: "🇮🇳", label: "India" },
    { id: "__more", icon: "☰", label: "More" },
  ];
  function renderBottomNav() {
    const bn = $("#bottomNav");
    bn.innerHTML = BOTTOM_NAV.map(it =>
      `<button class="bn-item" data-sec="${it.id}" aria-label="${it.label}">
        <span class="bn-ic">${it.icon}</span><span class="bn-lb">${it.label}</span></button>`).join("");
    bn.addEventListener("click", e => {
      const b = e.target.closest(".bn-item"); if (!b) return;
      if (b.dataset.sec === "__more") openSheet();
      else { closeSheet(); go(b.dataset.sec); }
    });
  }

  function openSheet() {
    const sheet = $("#mobileSheet");
    const isLight = document.documentElement.classList.contains("light");
    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-actions">
        <button class="tb-btn primary" data-act="ask">✦ Ask</button>
        <button class="tb-btn" data-act="refresh">↻ Refresh</button>
        <button class="tb-btn" data-act="theme">${isLight ? "☀️ Light" : "🌙 Dark"}</button>
      </div>
      ${NAV.map(g => `<div class="sheet-group"><div class="sheet-label">${g.group}</div>
        ${g.items.filter(it => !it.ownerOnly || isOwner()).map(it => `<button class="sheet-item ${it.id === state.section ? "active" : ""}" data-sec="${it.id}">
          <span class="ic">${it.icon}</span>${it.label}</button>`).join("")}</div>`).join("")}`;
    sheet.querySelectorAll(".sheet-item").forEach(el => el.onclick = () => { closeSheet(); go(el.dataset.sec); });
    sheet.querySelectorAll("[data-act]").forEach(el => el.onclick = () => {
      const a = el.dataset.act;
      if (a === "ask") { closeSheet(); openAsk(); }
      else if (a === "refresh") { closeSheet(); refreshNews(); }
      else if (a === "theme") { toggleTheme(); openSheet(); }
    });
    $("#sheetScrim").classList.add("show");
    sheet.classList.add("show");
  }
  function closeSheet() {
    $("#mobileSheet").classList.remove("show");
    $("#sheetScrim").classList.remove("show");
  }

  function setActiveNav() {
    $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.sec === state.section));
    $$(".bn-item").forEach(b => b.classList.toggle("active", b.dataset.sec === state.section));
  }

  async function boot() {
    captureOwnerToken();                                      // /#owner=<token> unlocks owner mode
    const identity = store.get("identity", null);
    const forceGate = location.search.includes("gate=1");     // ?gate=1 to preview the sign-in
    if ((!identity && !LOCAL) || forceGate) { showLoginGate(); return; }   // visitors must sign in
    if (identity) postLogin(identity);                        // re-announce on each load
    startApp();
  }

  // Owner opens https://<app>/#owner=<token> once → store it, then scrub it from the URL.
  function captureOwnerToken() {
    const m = /(?:^|[#&])owner=([^&]+)/.exec(location.hash);
    if (!m) return;
    try { store.set("owner_token", decodeURIComponent(m[1])); } catch { store.set("owner_token", m[1]); }
    const cleaned = location.hash.replace(/(?:^|[#&])owner=[^&]+/, "").replace(/^#&?/, "#");
    try { history.replaceState(null, "", location.pathname + location.search + (cleaned === "#" ? "" : cleaned)); } catch {}
  }

  async function startApp() {
    // WARM path: register the SW message listener FIRST (before any await) — SW
    // 'message' events aren't buffered, so a notification tapped mid-boot must not
    // be dropped. openAlertStory only needs the static #drawer DOM, so this is safe early.
    if ("serviceWorker" in navigator && navigator.serviceWorker.addEventListener) {
      navigator.serviceWorker.addEventListener("message", e => {
        const m = e.data || {};
        if (m.type === "open-alert" && m.alert) { try { window.focus(); } catch {} openAlertStory(m.alert); }
      });
    }
    renderNav();
    renderBottomNav();
    applyTheme(store.get("theme", "dark"));
    bindKeys();
    bindSearch();
    buildPalette();
    await pollStatus();                 // ensure categories/meta are loaded before first render
    setInterval(pollStatus, 15000);
    routeHash(false);                   // initial route (handles #alert=<id> deep links)
    window.addEventListener("hashchange", () => routeHash(true));
    registerSW();                       // for local-alert notifications (+ future offline)
    startAlertsLoop();                  // resume alerts if the user enabled them before
    loadAlertTopics();                  // preload world-alert category catalog
  }

  // Route the URL hash. A #alert=<id> deep link (from a notification cold-open)
  // lands on the Alerts page and opens that story in the in-app reader.
  function routeHash(fromHash) {
    const h = location.hash.slice(1);
    if (h.indexOf("alert=") === 0) {
      let id = h.slice(6);
      try { id = decodeURIComponent(id); } catch {}   // tolerate a malformed % sequence
      go("alerts");
      openAlertById(id);
      return;
    }
    go(h || "home", fromHash);
  }

  // ============================================================== Login gate
  function postLogin(identity) {
    try {
      fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(identity) });
    } catch {}
  }

  async function showLoginGate() {
    let cfg = {};
    try { cfg = await api("/api/config"); } catch {}
    const gate = document.createElement("div");
    gate.id = "loginGate";
    gate.className = "login-gate";
    document.body.appendChild(gate);
    if (cfg.google_client_id) showGoogleGate(gate, cfg.google_client_id);
    else showSimpleGate(gate);
  }

  function showGoogleGate(gate, clientId) {
    gate.innerHTML = `
      <div class="login-card">
        <div class="login-brand"><div class="logo">🛰️</div>
          <div><b>News Intel</b><small>Intelligence Desk</small></div></div>
        <h2>Welcome 👋</h2>
        <p class="login-sub">Sign in with Google to enter the briefing.</p>
        <div id="googleBtn" class="google-btn-wrap"></div>
        <div class="login-err" id="gErr" style="text-align:center"></div>
        <p class="login-fine">We use your Google name, email &amp; profile photo so the owner knows who's reading. Nothing is posted anywhere.</p>
      </div>`;
    const err = gate.querySelector("#gErr");
    const handle = async (resp) => {
      err.textContent = "Signing you in…";
      try {
        const r = await fetch("/api/google-login", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credential: resp.credential }) }).then(x => x.json());
        if (!r.ok) throw new Error(r.error || "Sign-in failed.");
        store.set("identity", { name: r.name, email: r.email, google: true });
        gate.classList.add("done"); setTimeout(() => gate.remove(), 350);
        startApp();
      } catch (e) { err.textContent = e.message || "Something went wrong."; }
    };
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.defer = true;
    s.onload = () => {
      try {
        google.accounts.id.initialize({ client_id: clientId, callback: handle });
        google.accounts.id.renderButton(gate.querySelector("#googleBtn"),
          { theme: "filled_blue", size: "large", shape: "pill", text: "continue_with", width: 300 });
      } catch (e) { err.textContent = "Google sign-in failed to start."; }
    };
    s.onerror = () => { err.textContent = "Couldn't reach Google — check your connection."; };
    document.head.appendChild(s);
  }

  function showSimpleGate(gate) {
    gate.innerHTML = `
      <div class="login-card">
        <div class="login-brand"><div class="logo">🛰️</div>
          <div><b>News Intel</b><small>Intelligence Desk</small></div></div>
        <h2>Welcome 👋</h2>
        <p class="login-sub">Quick sign-in to enter the briefing.</p>
        <label class="login-field"><span>Your name</span>
          <input id="lgName" placeholder="e.g. Priya Sharma" autocomplete="name"></label>
        <label class="login-field"><span>Email</span>
          <input id="lgEmail" type="email" placeholder="you@example.com" autocomplete="email"></label>
        <div class="captcha" id="captcha"></div>
        <div class="login-err" id="lgErr"></div>
        <button class="login-btn" id="lgEnter" disabled>Enter →</button>
        <p class="login-fine">No password needed. This just lets the owner see who's reading — your name &amp; email aren't shared anywhere else.</p>
      </div>`;
    const name = gate.querySelector("#lgName"), email = gate.querySelector("#lgEmail"),
          btn = gate.querySelector("#lgEnter"), err = gate.querySelector("#lgErr");
    let verified = false;
    const revalidate = () => {
      const ok = name.value.trim().length >= 2 &&
        /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim()) && verified;
      btn.disabled = !ok;
    };
    buildVerifier(gate.querySelector("#captcha"), (ok) => { verified = ok; revalidate(); });
    name.oninput = revalidate; email.oninput = revalidate;
    name.focus();
    email.addEventListener("keydown", e => { if (e.key === "Enter" && !btn.disabled) btn.click(); });
    btn.onclick = async () => {
      const identity = { name: name.value.trim(), email: email.value.trim() };
      const photo = window._capturedPhoto || null;
      btn.disabled = true; btn.textContent = "Entering…"; err.textContent = "";
      try {
        const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...identity, photo }) }).then(x => x.json());
        if (!r.ok) throw new Error(r.error || "Sign-in failed.");
        store.set("identity", identity);            // photo not stored client-side; server keeps it
        gate.querySelector("#captcha")._stopCam && gate.querySelector("#captcha")._stopCam();
        window._capturedPhoto = null;
        gate.classList.add("done");
        setTimeout(() => gate.remove(), 350);
        startApp();
      } catch (e) {
        err.textContent = e.message || "Something went wrong."; btn.disabled = false; btn.textContent = "Enter →";
      }
    };
  }

  // Camera selfie verifier — falls back to the emoji challenge if no camera / denied.
  async function buildVerifier(box, onChange) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return buildCaptcha(box, onChange);
    }
    box.innerHTML = `
      <div class="cap-head"><span class="cap-check" id="capCheck"></span>
        <span>📸 Smile &amp; snap a quick selfie to prove you're human</span></div>
      <div class="cam-stage">
        <video id="camVideo" autoplay playsinline muted></video>
        <img id="camShot" class="cam-shot" alt="">
        <div class="cam-msg" id="camMsg">Starting camera…</div>
      </div>
      <div class="cam-controls">
        <button type="button" class="cam-btn" id="camBtn" disabled>😊 Capture</button>
        <button type="button" class="cam-btn ghost" id="camRetake" style="display:none">↺ Retake</button>
      </div>
      <div class="cap-hint">Only the dashboard owner sees this — it just confirms a real person opened the link.</div>`;
    const video = box.querySelector("#camVideo"), shot = box.querySelector("#camShot"),
          msg = box.querySelector("#camMsg"), btn = box.querySelector("#camBtn"),
          retake = box.querySelector("#camRetake");
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 480, height: 360 }, audio: false });
      video.srcObject = stream; msg.style.display = "none"; btn.disabled = false;
    } catch (e) {
      box.innerHTML = ""; box._stopCam = null;
      return buildCaptcha(box, onChange);          // denied / unavailable → emoji fallback
    }
    box._stopCam = () => { try { stream.getTracks().forEach(t => t.stop()); } catch {} };
    window._capturedPhoto = null;
    btn.onclick = () => {
      const c = document.createElement("canvas"); c.width = 320; c.height = 240;
      c.getContext("2d").drawImage(video, 0, 0, 320, 240);
      window._capturedPhoto = c.toDataURL("image/jpeg", 0.7);
      shot.src = window._capturedPhoto; shot.style.display = "block"; video.style.display = "none";
      btn.style.display = "none"; retake.style.display = "inline-flex";
      box.classList.add("cap-ok"); box.querySelector("#capCheck").textContent = "✓";
      onChange(true);
    };
    retake.onclick = () => {
      window._capturedPhoto = null; shot.style.display = "none"; video.style.display = "block";
      btn.style.display = "inline-flex"; retake.style.display = "none";
      box.classList.remove("cap-ok"); box.querySelector("#capCheck").textContent = "";
      onChange(false);
    };
  }

  const CAP_SETS = [
    { label: "apples", t: "🍎", d: ["🍌", "🍇", "🍊", "🍉", "🍓", "🥝", "🍍", "🥥"] },
    { label: "dogs", t: "🐶", d: ["🐱", "🐰", "🐼", "🦊", "🐯", "🐵", "🐷", "🐮"] },
    { label: "cars", t: "🚗", d: ["✈️", "🚲", "🚂", "🚀", "⛵", "🚁", "🏍️", "🚜"] },
    { label: "trees", t: "🌳", d: ["🌵", "🌻", "🍄", "🌶️", "🏔️", "🌊", "🔥", "🌸"] },
    { label: "stars", t: "⭐", d: ["🌙", "☀️", "☁️", "❄️", "🌈", "⚡", "💧", "🌺"] },
  ];
  function buildCaptcha(box, onChange) {
    const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);
    function render() {
      const set = CAP_SETS[Math.floor(Math.random() * CAP_SETS.length)];
      const N = 3;
      const cells = [];
      for (let i = 0; i < N; i++) cells.push({ e: set.t, t: 1 });
      shuffle(set.d).slice(0, 9 - N).forEach(e => cells.push({ e, t: 0 }));
      const grid = shuffle(cells);
      box.classList.remove("cap-ok");
      box.innerHTML = `
        <div class="cap-head"><span class="cap-check" id="capCheck"></span>
          <span>Tap all the <b>${set.label}</b> ${set.t} — prove you're not a robot</span></div>
        <div class="cap-grid">${grid.map((c, i) => `<button type="button" class="cap-cell" data-i="${i}" data-t="${c.t}">${c.e}</button>`).join("")}</div>
        <div class="cap-hint" id="capHint">Select all ${N}.</div>`;
      onChange(false);
      const hint = box.querySelector("#capHint");
      box.querySelectorAll(".cap-cell").forEach(cell => cell.onclick = () => {
        if (box.classList.contains("cap-ok")) return;
        cell.classList.toggle("sel");
        const sel = [...box.querySelectorAll(".cap-cell.sel")];
        const wrong = sel.filter(c => c.dataset.t === "0").length;
        const right = sel.filter(c => c.dataset.t === "1").length;
        if (wrong === 0 && right === N) {
          box.classList.add("cap-ok");
          box.querySelector("#capCheck").textContent = "✓";
          hint.textContent = "Verified — you're human ✓";
          box.querySelectorAll(".cap-cell").forEach(c => c.disabled = true);
          onChange(true);
        } else if (wrong > 0) {
          hint.textContent = `That one isn't ${set.label} — tap it again to deselect.`;
          onChange(false);
        } else {
          hint.textContent = `Keep going — tap all ${N} ${set.label}.`;
          onChange(false);
        }
      });
    }
    render();
  }

  let _refreshing = false;
  async function refreshNews() {
    if (_refreshing) return;
    _refreshing = true;
    const icon = $("#refreshIcon"), btn = $("#refreshBtn");
    icon.textContent = "↻"; icon.classList.add("spinning"); btn.disabled = true;
    toast("Fetching the latest news…");
    const before = state.meta?.last_refresh || 0;
    try {
      await api("/api/refresh");
      // poll until the server reports a newer refresh (or 30s timeout)
      for (let i = 0; i < 20; i++) {
        await new Promise(z => setTimeout(z, 1500));
        const s = await api("/api/status");
        state.meta = s;
        if (!s.refreshing && s.last_refresh > before) break;
      }
      go(state.section, true);          // re-render current view with fresh data
      toast("✓ News updated");
    } catch { toast("Refresh failed — is the server running?"); }
    finally {
      _refreshing = false;
      icon.classList.remove("spinning"); btn.disabled = false;
      pollStatus();
    }
  }

  async function pollStatus() {
    try {
      const s = await api("/api/status");
      state.meta = s;
      $("#statusDot").classList.toggle("loading", s.loading);
      const when = s.last_refresh ? timeAgo(s.last_refresh * 1000) : "starting…";
      $("#statusText").textContent = s.loading ? "Fetching…" : `${s.count} articles · ${when}`;
    } catch { $("#statusText").textContent = "offline"; }
  }

  // ============================================================== Routing
  function go(sec, fromHash) {
    state.section = sec;
    state.page = 0;
    state.stories = [];
    if (state._visTimer) { clearInterval(state._visTimer); state._visTimer = null; }
    if (!fromHash) location.hash = sec;
    setActiveNav();
    if (sec === "home") return renderHome();
    if (sec === "shorts") return renderShorts();
    if (sec === "trending") return renderTrending();
    if (sec === "map") return renderMap();
    if (sec === "local") return renderLocal();
    if (sec === "alerts") return renderAlerts();
    if (sec === "bookmarks") return renderBookmarks();
    if (sec === "history") return renderHistory();
    if (sec === "visitors") return isOwner() ? renderVisitors() : go("home");
    if (sec === "breaking") return renderFeedPage({ title: "Breaking", sub: "Highest-importance stories across all sources, last 24h", sort: "importance", hours: 24 });
    if (sec === "world") return renderFeedPage({ title: "World", sub: "Global coverage merged across publishers", scope: "world" });
    if (sec === "india") return renderIndia();
    if (sec.startsWith("cat:")) {
      const cat = sec.slice(4);
      return renderCategoryPage(cat);
    }
    renderHome();
  }

  // ============================================================== Home
  async function renderHome() {
    const c = $("#content");
    c.innerHTML = `
      <div class="page-head">
        <div><h1>${briefingTitle()}</h1>
          <p>Live, cross-source coverage with bias &amp; reliability signals</p></div>
        <div style="display:flex;gap:8px">
          <button class="tb-btn" onclick="App.go('breaking')">⚡ Breaking</button>
          <button class="tb-btn primary" onclick="App.openAsk()">✦ Ask the News</button>
        </div>
      </div>
      ${filterBar({ showCats: true })}
      <div class="feed-layout">
        <div><div class="feed" id="feed">${skeletons(6)}</div>
          <div id="more"></div></div>
        <div class="rail" id="rail">${railSkeleton()}</div>
      </div>`;
    bindFilters();
    loadFeed({ sort: state.sort });
    loadRail();
  }

  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? "good morning." : h < 18 ? "good afternoon." : "good evening.";
  }

  function briefingTitle() {
    const h = new Date().getHours();
    const id = store.get("identity");
    let name = (id && id.name ? String(id.name).trim().split(/\s+/)[0] : "");
    if (name) name = name.charAt(0).toUpperCase() + name.slice(1);
    const who = name ? esc(name) : "there";
    const poss = name ? esc(name) + "’s" : "Your";

    // time-of-day greeting phrases, each paired with a fitting "live" emoji
    const bucket =
      h < 5  ? [["🌙", "Burning the midnight oil"], ["🌌", "Up late"], ["✨", "Hello, night owl"]] :
      h < 12 ? [["👋", "Good morning"], ["☀️", "Rise and shine"], ["🌅", "Top of the morning"], ["☕", "Morning"], ["🌞", "Good morning"]] :
      h < 17 ? [["👋", "Good afternoon"], ["🌤️", "Good afternoon"], ["✨", "Hey there"], ["🙌", "Afternoon"]] :
      h < 21 ? [["🌆", "Good evening"], ["👋", "Good evening"], ["🌙", "Evening"], ["✨", "Hope your day went well"]] :
               [["🌙", "Working late"], ["🌌", "Good evening"], ["✨", "Evening"], ["🦉", "Night owl mode"]];
    const g = bucket[Math.floor(Math.random() * bucket.length)];

    // varied heading shapes — picked fresh on every open
    const shapes = [
      () => `<span class="wave">${g[0]}</span> ${g[1]}, ${who} — your Intelligence Briefing`,
      () => `<span class="wave">📰</span> ${poss} Intelligence Briefing`,
      () => `<span class="wave">${g[0]}</span> ${g[1]}, ${who}`,
      () => `<span class="wave">🧠</span> ${poss} Briefing, ${g[1].toLowerCase()}`,
    ];
    return shapes[Math.floor(Math.random() * shapes.length)]();
  }

  async function loadRail() {
    const rail = $("#rail");
    try {
      const [t, m] = await Promise.all([api("/api/trends?scope="), api("/api/map")]);
      rail.innerHTML = trendsPanel(t.trends) + mapPanel(m.countries, 8);
    } catch { rail.innerHTML = ""; }
  }

  // ============================================================== In Short (Inshorts-style deck)
  const SHORTS_TABS = ["All", "India", "World", "Business", "Technology", "AI",
    "Sports", "Science", "Health", "Cryptocurrency", "Politics", "Entertainment"];

  async function renderShorts() {
    if (!state.shortsTab) state.shortsTab = "All";
    const c = $("#content");
    c.innerHTML = `
      <div class="shorts-stage">
        <div class="shorts-topbar">
          <div><h1 style="font-size:20px;margin:0">🗞️ In Short</h1>
            <p style="margin:2px 0 0;color:var(--muted);font-size:12.5px">60-word briefs — swipe / scroll · ↑↓ keys</p></div>
          <div class="shorts-controls">
            <span class="shorts-count" id="shortsCount" aria-live="polite">– / –</span>
            <button class="icon-btn" id="shPrev" title="Previous (↑)" aria-label="Previous story">↑</button>
            <button class="icon-btn" id="shNext" title="Next (↓)" aria-label="Next story">↓</button>
          </div>
        </div>
        <div class="shorts-tabs" id="shortsTabs">
          ${SHORTS_TABS.map(t => `<button class="chip ${t === state.shortsTab ? "active" : ""}" data-tab="${t}">${t}</button>`).join("")}
        </div>
        <div class="shorts-deck" id="shortsDeck">${shortsSkeleton()}</div>
      </div>`;
    $("#shortsTabs").addEventListener("click", e => {
      const b = e.target.closest("[data-tab]"); if (!b) return;
      state.shortsTab = b.dataset.tab;
      $$("#shortsTabs .chip").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      loadShorts();
    });
    loadShorts();
  }

  async function loadShorts() {
    const tab = state.shortsTab || "All";
    const params = tab === "India" ? "scope=india"
      : tab === "World" ? "scope=world"
      : tab === "All" ? "" : "cat=" + encodeURIComponent(tab);
    $("#shortsDeck").innerHTML = shortsSkeleton();
    try {
      const r = await api("/api/shorts" + (params ? "?" + params : ""));
      r.stories.forEach(s => state.storiesById[s.story_id] = s);
      state._shorts = r.stories;
      if (!r.stories.length && state.meta?.loading) {
        clearTimeout(state._retry);
        state._retry = setTimeout(() => { if (state.section === "shorts") loadShorts(); }, 1500);
        return;
      }
      paintShorts(r.stories);
    } catch { $("#shortsDeck").innerHTML = emptyState("Couldn't load briefs.", "🗞️"); }
  }

  function paintShorts(stories) {
    const deck = $("#shortsDeck");
    if (!stories.length) { deck.innerHTML = emptyState("No briefs available yet.", "🗞️"); return; }
    deck.innerHTML = stories.map((s, i) => shortCard(s, i, stories.length)).join("");
    $("#shortsCount").textContent = `1 / ${stories.length}`;
    bindShorts(deck, stories);
  }

  function shortCard(s, i, total) {
    const brief = (s.summaries && s.summaries.brief) || s.summary || s.title;
    const bm = isBookmarked(s.story_id);
    const byline = [s.published ? timeAgo(s.published) : null, s.author ? esc(s.author) : null, esc(s.publisher)]
      .filter(Boolean).join(" · ");
    const img = `<div class="short-img${s.image ? "" : " noimg"}">
        ${s.image ? `<img src="${esc(s.image)}" loading="lazy" alt="" onerror="this.parentNode.classList.add('noimg');this.remove();">` : ""}
        <span class="short-img-emoji">🗞️</span><div class="short-img-grad"></div>
        <div class="short-brand">🗞️ News Intel</div>
        <div class="short-imgactions">
          <button class="img-btn ${bm ? "on" : ""}" data-bm="${s.story_id}" aria-label="${bm ? "Remove bookmark" : "Bookmark"}">${bm ? "🔖" : "🏷️"}</button>
          <button class="img-btn" data-listen="${s.story_id}" aria-label="Listen to this story">🔊</button>
        </div>
      </div>`;
    return `
    <article class="short-card" data-i="${i}" data-id="${s.story_id}">
      ${img}
      <div class="short-body">
        <div class="short-cat-row">
          <span class="tag cat">${esc(s.category)}</span>
          ${s.importance_band !== "Low" ? `<span class="tag imp-${s.importance_band}">${s.importance_band === "High" ? "🔴" : "🟠"} ${s.importance_band}</span>` : ""}
          ${s.num_publishers > 1 ? `<span class="tag sources" data-srcopen="${s.story_id}">⊕ ${s.num_publishers} sources</span>` : ""}
          <span class="short-idx">${i + 1} / ${total}</span>
        </div>
        <h2 data-open="${s.story_id}">${esc(s.title)}</h2>
        <p class="short-brief">${esc(brief)}</p>
      </div>
      <div class="short-foot">
        <div class="short-byline-line">${byline} ${relPill(s.reliability)}</div>
        <div class="short-actions">
          <button class="icon-btn" data-open="${s.story_id}" title="Full story" aria-label="Open full story">⤢</button>
          <a class="icon-btn" href="${esc(safeUrl(s.link))}" target="_blank" rel="noopener" title="Read at source" aria-label="Read at source">↗</a>
        </div>
      </div>
    </article>`;
  }

  function bindShorts(deck, stories) {
    $$("[data-open]", deck).forEach(el => el.onclick = () => openStory(el.dataset.open));
    $$("[data-srcopen]", deck).forEach(el => el.onclick = () => openStory(el.dataset.srcopen, "sources"));
    $$("[data-bm]", deck).forEach(el => el.onclick = e => { e.stopPropagation(); toggleBookmark(el.dataset.bm, el); });
    $$("[data-listen]", deck).forEach(el => el.onclick = e => { e.stopPropagation(); listen(state.storiesById[el.dataset.listen]); });
    deck.onscroll = () => {
      const idx = shortsCurrentIndex(deck) + 1;
      $("#shortsCount").textContent = `${Math.min(idx, stories.length)} / ${stories.length}`;
    };
    $("#shPrev").onclick = () => shortsNav(-1);
    $("#shNext").onclick = () => shortsNav(1);
  }

  function shortsCurrentIndex(deck) {
    const cards = [...deck.querySelectorAll(".short-card")];
    const st = deck.scrollTop;
    let best = 0, bd = Infinity;
    cards.forEach((c, i) => { const d = Math.abs(c.offsetTop - st); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  function shortsNav(dir) {
    const deck = $("#shortsDeck"); if (!deck) return;
    const cards = deck.querySelectorAll(".short-card");
    if (!cards.length) return;
    const target = Math.max(0, Math.min(shortsCurrentIndex(deck) + dir, cards.length - 1));
    deck.scrollTop = cards[target].offsetTop;   // direct assignment + CSS smooth-scroll
  }

  function shortsSkeleton() {
    return `<div class="short-card"><div class="short-img sk"></div>
      <div class="short-body"><div class="sk" style="height:24px;width:90%;margin-bottom:12px"></div>
      <div class="sk" style="height:14px;width:100%;margin-bottom:7px"></div>
      <div class="sk" style="height:14px;width:96%;margin-bottom:7px"></div>
      <div class="sk" style="height:14px;width:70%"></div></div></div>`;
  }

  // ============================================================== Generic feed page
  async function renderFeedPage(opts) {
    state.sort = opts.sort || "time";
    state.hours = opts.hours || null;
    const c = $("#content");
    c.innerHTML = `
      <div class="page-head"><div><h1>${opts.title}</h1><p>${opts.sub}</p></div></div>
      ${filterBar({ showCats: true })}
      <div class="feed-layout">
        <div><div class="feed" id="feed">${skeletons(6)}</div><div id="more"></div></div>
        <div class="rail" id="rail">${railSkeleton()}</div>
      </div>`;
    bindFilters();
    loadFeed({ scope: opts.scope, sort: state.sort, hours: state.hours });
    loadRail();
  }

  async function renderIndia() {
    const c = $("#content");
    const states = (state.meta?.states || []);
    c.innerHTML = `
      <div class="page-head"><div><h1>🇮🇳 India</h1><p>National coverage across Indian publishers — filter by state/UT</p></div></div>
      ${filterBar({ showCats: true, extra: `
        <select class="f-select" id="stateSel">
          <option value="">All states / UTs</option>
          ${states.map(s => `<option>${s}</option>`).join("")}
        </select>` })}
      <div class="feed-layout">
        <div><div class="feed" id="feed">${skeletons(6)}</div><div id="more"></div></div>
        <div class="rail" id="rail">${railSkeleton()}</div>
      </div>`;
    bindFilters();
    $("#stateSel").addEventListener("change", e => {
      state.state_filter = e.target.value; state.page = 0; loadFeed({ scope: "india" });
    });
    loadFeed({ scope: "india" });
    api("/api/trends?scope=india").then(t => {
      $("#rail").innerHTML = trendsPanel(t.trends, "Trending in India");
    });
  }

  async function renderCategoryPage(cat) {
    const india = false;
    const c = $("#content");
    c.innerHTML = `
      <div class="page-head"><div><h1>${cat}</h1><p>Direct-feed coverage + Google News topic merge, de-duplicated across sources</p></div></div>
      <div class="feed-layout">
        <div><div class="feed" id="feed">${skeletons(6)}</div></div>
        <div class="rail" id="rail">${railSkeleton()}</div>
      </div>`;
    try {
      const r = await api(`/api/category?cat=${encodeURIComponent(cat)}${india ? "&india=1" : ""}`);
      paintStories(r.stories);
    } catch { $("#feed").innerHTML = emptyState("Couldn't load this desk."); }
    loadRail();
  }

  // ============================================================== Feed loading
  async function loadFeed(extra = {}, append = false) {
    const params = new URLSearchParams();
    if (extra.scope) params.set("scope", extra.scope);
    if (state.category) params.set("category", state.category);
    params.set("sort", extra.sort || state.sort);
    if (extra.hours || state.hours) params.set("hours", extra.hours || state.hours);
    if (state.minRel) params.set("min_reliability", state.minRel);
    if (state.bias) params.set("bias", state.bias);
    if (state.state_filter) params.set("state", state.state_filter);
    params.set("page", state.page);
    params.set("size", state.size);
    state._lastExtra = extra;
    try {
      const r = await api("/api/feed?" + params.toString());
      state.total = r.total;
      if (append) { state.stories.push(...r.stories); paintMore(r.stories); }
      else { state.stories = r.stories; paintStories(r.stories); }
      r.stories.forEach(s => state.storiesById[s.story_id] = s);
      renderLoadMore();
      // First-run race: feed asked before the background fetch finished.
      // Retry shortly until the server has data.
      if (!append && !r.stories.length && (r.loading || state.meta?.loading)) {
        clearTimeout(state._retry);
        state._retry = setTimeout(() => { if (state.section !== "search") loadFeed(extra); }, 1500);
      }
    } catch (e) {
      $("#feed").innerHTML = emptyState("Feed unavailable. Is the server running?");
    }
  }

  function renderLoadMore() {
    const m = $("#more"); if (!m) return;
    const shown = state.stories.length;
    m.innerHTML = shown < state.total
      ? `<button class="tb-btn load-more" onclick="App.more()">Load more (${state.total - shown} more)</button>` : "";
  }
  function more() {
    if (state.loadingMore) return;
    state.loadingMore = true; state.page++;
    loadFeed(state._lastExtra || {}, true).finally(() => state.loadingMore = false);
  }

  function paintStories(stories) {
    const feed = $("#feed"); if (!feed) return;
    if (!stories.length) {
      feed.innerHTML = state.meta?.loading
        ? skeletons(5) : emptyState("No stories match these filters yet.");
      return;
    }
    feed.innerHTML = stories.map(card).join("");
    bindCards(feed);
  }
  function paintMore(stories) {
    const feed = $("#feed");
    const html = stories.map(card).join("");
    feed.insertAdjacentHTML("beforeend", html);
    bindCards(feed);
  }

  // ============================================================== Story card
  function card(s) {
    const bm = isBookmarked(s.story_id);
    const img = s.image ? `<img class="thumb" src="${esc(s.image)}" loading="lazy" onerror="this.style.display='none'">` : "";
    return `
    <article class="card" data-id="${s.story_id}">
      <div class="body">
        <div class="meta" style="margin-bottom:8px">
          <span class="tag cat">${esc(s.category)}</span>
          ${s.importance_band !== "Low" ? `<span class="tag imp-${s.importance_band}">${s.importance_band === "High" ? "🔴" : "🟠"} ${s.importance_band} impact</span>` : ""}
          ${s.num_publishers > 1 ? `<span class="tag sources" data-id="${s.story_id}">⊕ ${s.num_publishers} sources</span>` : ""}
        </div>
        <h3 data-open="${s.story_id}">${esc(s.title)}</h3>
        <p class="excerpt">${esc((s.summaries && s.summaries.brief) || s.summary || s.title)}</p>
        <div class="meta">
          <span class="pub">${esc(s.publisher)}</span>
          <span>${s.published ? timeAgo(s.published) : ""}</span>
          <span>${s.reading_time} min read</span>
          ${relPill(s.reliability)}
          ${biasTag(s.bias)}
        </div>
        ${s.num_publishers > 1 ? `<div class="src-strip">${s.publishers.slice(0, 5).map(p => `<span class="src-dot">${esc(p)}</span>`).join("")}${s.publishers.length > 5 ? `<span class="src-dot">+${s.publishers.length - 5}</span>` : ""}</div>` : ""}
      </div>
      ${img}
      <div class="card-actions">
        <button class="icon-btn ${bm ? "on" : ""}" data-bm="${s.story_id}" title="Bookmark">${bm ? "🔖" : "🏷️"}</button>
        <button class="icon-btn" data-listen="${s.story_id}" title="Listen">🔊</button>
        <a class="icon-btn" href="${esc(safeUrl(s.link))}" target="_blank" rel="noopener" title="Open source">↗</a>
      </div>
    </article>`;
  }

  function relPill(r) {
    if (!r) return `<span class="rel-pill" title="Unrated source"><span class="tag">Unrated</span></span>`;
    const col = r >= 85 ? "var(--green)" : r >= 70 ? "var(--amber)" : "var(--red)";
    return `<span class="rel-pill" title="Reliability ${r}/100 (approx.)">
      <span class="rel-bar"><i style="width:${r}%;background:${col}"></i></span>${r}</span>`;
  }
  function biasTag(b) {
    if (!b || b === "n/a") return "";
    return `<span class="tag" title="Approx. political lean">${esc(b)}</span>`;
  }

  function bindCards(root) {
    $$("[data-open]", root).forEach(el => el.onclick = () => openStory(el.dataset.open));
    $$(".tag.sources", root).forEach(el => el.onclick = () => openStory(el.dataset.id, "sources"));
    $$("[data-bm]", root).forEach(el => el.onclick = e => { e.stopPropagation(); toggleBookmark(el.dataset.bm, el); });
    $$("[data-listen]", root).forEach(el => el.onclick = e => { e.stopPropagation(); listen(state.storiesById[el.dataset.listen]); });
    $$(".card .thumb", root).forEach(el => el.onclick = () => { const c = el.closest(".card"); if (c) openStory(c.dataset.id); });
  }

  // ============================================================== Story drawer
  let drawerTab = "twomin";
  function openStory(id, focus) {
    const s = state.storiesById[id];
    if (!s) return;
    addHistory(s);
    drawerTab = "twomin";
    const d = $("#drawer");
    d.innerHTML = drawerHTML(s);
    $("#scrim").classList.add("show");
    d.classList.add("show");
    bindDrawer(s);
    if (focus === "sources") setTimeout(() => $("#srcSection")?.scrollIntoView({ behavior: "smooth" }), 250);
  }
  function closeDrawer() {
    $("#drawer").classList.remove("show");
    $("#scrim").classList.remove("show");
    window.speechSynthesis?.cancel();
  }

  function drawerHTML(s) {
    const sm = s.summaries;
    return `
    <div class="drawer-head">
      <h2>${esc(s.title)}</h2>
      <button class="close-x" onclick="App.closeDrawer()">✕</button>
    </div>
    <div class="drawer-body">
      <div class="meta" style="margin-bottom:14px">
        <span class="pub">${esc(s.publisher)}</span>
        ${s.author ? `<span>· ${esc(s.author)}</span>` : ""}
        <span>${s.published ? new Date(s.published).toLocaleString() : ""}</span>
        <span class="tag cat">${esc(s.category)}</span>
        <span class="tag imp-${s.importance_band}">${s.importance}/100 impact</span>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <a class="tb-btn primary" href="${esc(safeUrl(s.link))}" target="_blank" rel="noopener">↗ Read at source</a>
        <button class="tb-btn" id="bmBtn">${isBookmarked(s.story_id) ? "🔖 Bookmarked" : "🏷️ Bookmark"}</button>
        <button class="tb-btn" id="listenBtn">🔊 Listen</button>
        <a class="tb-btn" href="https://translate.google.com/?sl=auto&tl=en&text=${encodeURIComponent(s.title)}" target="_blank" rel="noopener">🌐 Translate</a>
        <a class="tb-btn" href="${esc(s.archive)}" target="_blank" rel="noopener">🗄️ Archive</a>
      </div>

      <div class="sec-title">AI Summary</div>
      <div class="seg" id="sumSeg">
        <button data-t="thirty">30-sec</button>
        <button data-t="twomin" class="active">2-min</button>
        <button data-t="bullets">Bullets</button>
        <button data-t="eli5">ELI5</button>
        <button data-t="detailed">Detailed</button>
        <button data-t="timeline">Timeline</button>
      </div>
      <div class="summary-box" id="sumBox">${renderSummary(s, "twomin")}</div>
      <p class="disclaimer">Extractive summary built from the publisher's own RSS text — not a generative model, so it won't invent details. Open the source for the full article.</p>

      <div class="sec-title">Source Transparency</div>
      <div class="transparency">
        <div class="tcard"><div class="k">Publisher</div><div class="v">${esc(s.publisher)}</div></div>
        <div class="tcard"><div class="k">Origin country</div><div class="v">${esc(s.country)}</div></div>
        <div class="tcard"><div class="k">Ownership</div><div class="v" style="font-size:13px">${esc(s.ownership)}</div></div>
        <div class="tcard"><div class="k">Reliability (approx.)</div><div class="v">${s.reliability ? s.reliability + "/100" : "Unrated"}</div></div>
        <div class="tcard" style="grid-column:1/-1">
          <div class="k">Political lean (approx.)</div>
          <div class="v" style="font-size:13px;margin-bottom:4px">${s.bias === "n/a" ? "Not applicable" : esc(s.bias)}</div>
          <div class="bias-dial"><i style="left:${((s.bias_pos + 2) / 4) * 100}%"></i></div>
          <div class="bias-scale"><span>Left</span><span>Center</span><span>Right</span></div>
        </div>
      </div>

      <div class="sec-title" id="srcSection">Cross-Source Comparison · ${s.num_publishers} publisher${s.num_publishers > 1 ? "s" : ""}</div>
      ${s.num_publishers > 1
        ? `<p class="disclaimer" style="margin-bottom:10px">These outlets are reporting what looks like the same event (matched on headline entities). Compare framing &amp; reliability side by side.</p>`
        : `<p class="disclaimer" style="margin-bottom:10px">Only one source in the current feed is carrying this story. More may appear after the next refresh.</p>`}
      <div>${s.sources.map(sourceItem).join("")}</div>

      <div class="sec-title">Timeline</div>
      <div class="tl">${s.timeline.map(t => `
        <div class="tl-item">
          <time>${t.published ? new Date(t.published).toLocaleString() : "—"}</time>
          <b><a href="${esc(safeUrl(t.link))}" target="_blank" rel="noopener">${esc(t.title)}</a></b>
          <span>${esc(t.publisher)}</span>
        </div>`).join("")}</div>
    </div>`;
  }

  function sourceItem(src) {
    const col = src.reliability >= 85 ? "var(--green)" : src.reliability >= 70 ? "var(--amber)" : "var(--red)";
    return `<a class="source-item" href="${esc(safeUrl(src.link))}" target="_blank" rel="noopener">
      <div class="rel-bar" style="width:6px;height:34px;border-radius:4px"><i style="width:100%;height:${src.reliability}%;background:${col};display:block"></i></div>
      <div class="si-main"><b>${esc(src.publisher)}</b><p>${esc(src.title)}</p></div>
      <span class="mini-bias">${src.bias === "n/a" ? "—" : esc(src.bias)}</span>
      <span style="color:var(--faint);font-size:11px">${src.reliability || "—"}</span>
    </a>`;
  }

  function renderSummary(s, t) {
    const sm = s.summaries;
    if (t === "bullets") return "<ul>" + (sm.bullets.length ? sm.bullets : [s.title]).map(b => `<li>${esc(b)}</li>`).join("") + "</ul>";
    if (t === "timeline") return s.timeline.map(x => `<div style="margin-bottom:8px"><b>${x.published ? new Date(x.published).toLocaleString() : "—"}</b> · ${esc(x.publisher)}<br>${esc(x.title)}</div>`).join("");
    const map = { thirty: sm.thirty, twomin: sm.twomin, detailed: sm.detailed, eli5: sm.eli5 };
    return esc(map[t] || sm.twomin) || "No extended text in this feed item — open the source for full detail.";
  }

  function bindDrawer(s) {
    $$("#sumSeg button").forEach(b => b.onclick = () => {
      $$("#sumSeg button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      $("#sumBox").innerHTML = renderSummary(s, b.dataset.t);
    });
    $("#bmBtn").onclick = () => { toggleBookmark(s.story_id); $("#bmBtn").textContent = isBookmarked(s.story_id) ? "🔖 Bookmarked" : "🏷️ Bookmark"; };
    $("#listenBtn").onclick = () => listen(s);
  }

  // ============================================================== Trending
  async function renderTrending() {
    const c = $("#content");
    c.innerHTML = `<div class="page-head"><div><h1>📈 Trending</h1><p>Fastest-growing terms across the live feed (last 8h vs prior)</p></div></div>
      <div class="feed-layout"><div id="trendMain">${skeletons(4)}</div>
      <div class="rail"><div class="panel"><h4>🔥 Hot now</h4><div id="hotList"></div></div></div></div>`;
    const [tw, ti] = await Promise.all([api("/api/trends?scope="), api("/api/trends?scope=india")]);
    const main = $("#trendMain");
    main.innerHTML = `
      <div class="panel"><h4>🌍 Trending Worldwide</h4>${ti2rows(tw.trends, true)}</div>
      <div class="panel" style="margin-top:16px"><h4>🇮🇳 Trending in India</h4>${ti2rows(ti.trends, true)}</div>`;
    $("#hotList").innerHTML = tw.trends.filter(t => t.hot).slice(0, 8).map((t, i) =>
      `<div class="trend-row" onclick="App.searchTerm('${esc(t.term)}')"><span class="trank fire">🔥</span><span class="tterm">${esc(t.term)}</span><span class="tcount">${t.count}</span></div>`).join("") || `<p class="disclaimer">No breakout terms yet.</p>`;
    bindTrendRows(main);
  }
  function ti2rows(trends, big) {
    return `<div>${trends.map((t, i) => `
      <div class="trend-row" data-term="${esc(t.term)}">
        <span class="trank">${i + 1}</span>
        <span class="tterm">${t.hot ? "🔥 " : ""}${esc(t.term)}</span>
        <span class="tgrow ${t.growth <= 0 ? "down" : ""}">${t.growth > 0 ? "▲" : "▬"} ${t.recent} new</span>
        <span class="tcount">${t.count}</span>
      </div>`).join("")}</div>`;
  }
  function bindTrendRows(root) {
    $$(".trend-row[data-term]", root).forEach(el => el.onclick = () => searchTerm(el.dataset.term));
  }

  // ============================================================== Map
  async function renderMap() {
    const c = $("#content");
    c.innerHTML = `<div class="page-head"><div><h1>🗺️ World Map</h1><p>Click a country to see the latest stories mentioning it</p></div></div>
      <div class="feed-layout"><div id="mapMain">${skeletons(3)}</div>
      <div class="rail"><div class="panel" id="mapDetail"><h4>Select a country</h4><p class="disclaimer">Click any country tile to load its top stories here.</p></div></div></div>`;
    const m = await api("/api/map");
    const entries = Object.entries(m.countries).sort((a, b) => b[1].count - a[1].count);
    state._map = m.countries;
    $("#mapMain").innerHTML = `<div class="panel"><h4>🌐 Coverage by country</h4>
      <div class="map-grid">${entries.map(([name, d]) => `
        <div class="map-cell" data-c="${esc(name)}">
          <b>${esc(name)}</b><span>${d.count} stor${d.count === 1 ? "y" : "ies"}</span>
        </div>`).join("")}</div></div>`;
    $$("#mapMain .map-cell").forEach(el => el.onclick = () => showCountry(el.dataset.c));
  }
  function showCountry(name) {
    const d = state._map[name];
    const det = $("#mapDetail");
    det.innerHTML = `<h4>${esc(name)} · ${d.count}</h4>${
      d.top.length ? d.top.map(a => `<div class="trend-row"><a href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener" style="flex:1"><span class="tterm" style="text-transform:none">${esc(a.title)}</span><br><span class="tcount">${esc(a.publisher)}</span></a></div>`).join("")
        : `<p class="disclaimer">No stories currently mention ${esc(name)} in the feed.</p>`}`;
  }
  function mapPanel(countries, n) {
    const entries = Object.entries(countries).sort((a, b) => b[1].count - a[1].count).slice(0, n);
    return `<div class="panel"><h4>🗺️ World hotspots</h4>
      <div class="map-grid">${entries.map(([name, d]) => `
        <div class="map-cell" onclick="App.go('map')"><b>${esc(name)}</b><span>${d.count} stories</span></div>`).join("")}</div></div>`;
  }

  // ============================================================== Local
  async function renderLocal() {
    const saved = store.get("local", { city: "", radius: "25", topics: "" });
    const c = $("#content");
    c.innerHTML = `<div class="page-head"><div><h1>📍 Local News</h1><p>City-level news, civic alerts, traffic, weather, crime &amp; more</p></div></div>
      <div class="panel" style="margin-bottom:16px">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <input class="f-input" id="cityIn" placeholder="City (e.g. Bengaluru, Delhi)" value="${esc(saved.city)}" style="flex:1;min-width:180px">
          <button class="tb-btn" id="gpsBtn">📡 Use my location</button>
          <select class="f-select" id="radiusIn">
            ${["5", "10", "25", "50", "100"].map(r => `<option value="${r}" ${saved.radius === r ? "selected" : ""}>${r} km</option>`).join("")}
          </select>
          <button class="tb-btn primary" id="localGo">Show local news</button>
        </div>
        <div class="chips-scroll" id="localTopics" style="margin-top:12px">
          ${["Traffic", "Weather", "Crime", "Government", "Metro", "Power", "Water", "Election", "Events", "Construction"].map(t => `<button class="chip" data-topic="${t}">${t}</button>`).join("")}
        </div>
        <p class="disclaimer" style="margin-top:8px">Radius is a hint — RSS has no GPS filter, so results are city-keyword matched from Google News India. GPS resolves to your nearest city name.</p>
      </div>
      <div class="feed" id="feed">${saved.city ? skeletons(4) : emptyState("Enter a city to see local news.", "📍")}</div>`;
    const sel = new Set();
    $$("#localTopics .chip").forEach(ch => ch.onclick = () => {
      ch.classList.toggle("active");
      sel.has(ch.dataset.topic) ? sel.delete(ch.dataset.topic) : sel.add(ch.dataset.topic);
    });
    const run = () => {
      const city = $("#cityIn").value.trim();
      const radius = $("#radiusIn").value;
      const topics = [...sel].join(" ");
      if (!city) return toast("Enter a city first");
      store.set("local", { city, radius, topics });
      syncPush();                       // watched city changed → update push prefs
      $("#feed").innerHTML = skeletons(4);
      api(`/api/local?city=${encodeURIComponent(city)}&radius=${radius}&topics=${encodeURIComponent(topics)}`)
        .then(r => { paintStories(r.stories); if (!r.stories.length) $("#feed").innerHTML = emptyState(`No local stories found for ${esc(city)} right now.`, "📍"); });
    };
    $("#localGo").onclick = run;
    $("#cityIn").addEventListener("keydown", e => { if (e.key === "Enter") run(); });
    $("#gpsBtn").onclick = useGPS;
    if (saved.city) run();
  }

  function useGPS() {
    if (!navigator.geolocation) return toast("Geolocation not available");
    toast("Locating…");
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude, longitude } = pos.coords;
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10`, { headers: { "Accept": "application/json" } }).then(x => x.json());
        const city = r.address?.city || r.address?.town || r.address?.state_district || r.address?.county || r.address?.state || "";
        if (city) { $("#cityIn").value = city; toast("📍 " + city); $("#localGo").click(); }
        else toast("Couldn't resolve a city name");
      } catch { toast("Reverse-geocoding failed"); }
    }, () => toast("Location permission denied"), { timeout: 8000 });
  }

  // ============================================================== Local Alerts (notifications)
  function alertsCfg() {
    return store.get("alerts", { enabled: false, since: 0, seen: [], log: [] });
  }
  function saveAlertsCfg(c) { store.set("alerts", c); }

  async function registerSW() {
    if (!("serviceWorker" in navigator)) return null;
    try { return await navigator.serviceWorker.register("/sw.js"); }
    catch { return null; }
  }

  // ---- Background push (server-sent notifications, app can be closed) ----
  function urlB64ToU8(s) {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }
  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  let _vapidKey = null;
  async function getVapidKey() {
    if (_vapidKey) return _vapidKey;
    try { _vapidKey = (await api("/api/push/vapid-key")).key || null; } catch {}
    return _vapidKey;
  }

  // Subscribe this browser (or update its preferences) for server-side push,
  // so alerts arrive even when the app is closed. Safe no-op when unsupported.
  async function syncPush() {
    try {
      const cfg = alertsCfg();
      if (!cfg.enabled) return;
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      if (!("PushManager" in window)) return;
      const reg = await registerSW();
      if (!reg) return;
      await navigator.serviceWorker.ready;
      const key = await getVapidKey();
      if (!key) return;
      let sub = await reg.pushManager.getSubscription();
      // If the existing subscription was made with a DIFFERENT server key (e.g. the
      // server rotated vapid.json), it's dead — drop and re-subscribe so push heals.
      if (sub) {
        const cur = sub.options && sub.options.applicationServerKey;
        const want = urlB64ToU8(key);
        if (!cur || !sameBytes(new Uint8Array(cur), want)) {
          try { await sub.unsubscribe(); } catch {}
          sub = null;
        }
      }
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(key) });
      }
      const loc = store.get("local", null);
      await fetch("/api/push/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: sub.toJSON(),
          prefs: {
            world: cfg.world !== false,
            local: cfg.local !== false,
            worldCats: cfg.worldCats === undefined ? null : cfg.worldCats,
            city: (loc && loc.city) || "",
            topics: (loc && loc.topics) || "",
          },
        }),
      });
      state._pushOk = true;
      if (state.section === "alerts") renderAlerts();
    } catch { state._pushOk = false; }
  }

  async function stopPush() {
    try {
      if (!("serviceWorker" in navigator)) return;
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) {
        try {
          await fetch("/api/push/unsubscribe", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
        } catch {}
        await sub.unsubscribe();
      }
    } catch {}
    state._pushOk = false;
  }

  // Show one notification. Clicking it opens the story INSIDE the News Intel app
  // (in-app reader), not the publisher site. `alert` carries the story data; pass
  // null for non-story pings (which just focus the app).
  async function fireNotification(title, body, alert) {
    const hasStory = alert && alert.id;
    // Deep link used for a COLD open (app not running) — boot() reads #alert=<id>.
    const url = hasStory ? location.origin + "/#alert=" + encodeURIComponent(alert.id) : "/";
    const opts = {
      body, icon: "/icon-192.png", badge: "/icon-192.png",
      tag: (hasStory && alert.id) || title, renotify: true,
      data: { url, alert: hasStory ? alert : null },   // alert echoed back for the WARM (app-open) path
      vibrate: [120, 60, 120],
    };
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.ready;
        if (reg && reg.showNotification) { reg.showNotification(title, opts); return; }
      }
    } catch {}
    try {
      const n = new Notification(title, opts);
      n.onclick = () => { window.focus(); if (hasStory) openAlertStory(alert); n.close(); };
    } catch {}
  }

  async function pollAlerts(manual) {
    const cfg = alertsCfg();
    if (!cfg.enabled && !manual) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      if (manual) toast("Enable alerts first"); return;
    }
    const loc = store.get("local", null);
    const wantLocal = cfg.local !== false && loc && loc.city;
    // worldCats: undefined = all topics; [] = none selected (no world alerts); [keys] = subset
    const noWorldCats = Array.isArray(cfg.worldCats) && cfg.worldCats.length === 0;
    const wantWorld = cfg.world !== false && !noWorldCats;
    if (!wantLocal && !wantWorld) { if (manual) toast("Turn on world alerts, or set your city for local ones"); return; }

    const params = new URLSearchParams({ since: cfg.since || 0, world: wantWorld ? "1" : "0" });
    if (wantLocal) { params.set("city", loc.city); params.set("topics", loc.topics || ""); }
    if (wantWorld && Array.isArray(cfg.worldCats) && cfg.worldCats.length) params.set("wtopics", cfg.worldCats.join(","));
    let r;
    try { r = await api("/api/alerts?" + params.toString()); }
    catch { if (manual) toast("Couldn't check for alerts"); return; }

    const incoming = [];
    if (wantLocal) incoming.push(...(r.alerts || []));
    if (wantWorld) incoming.push(...(r.world || []));
    // Dedup on the cluster's article ids (src_ids) so a developing story whose lead
    // rotates isn't re-notified — same logic as the server-side push path.
    const seen = new Set(cfg.seen || []);
    const idsOf = a => (a.src_ids && a.src_ids.length) ? a.src_ids : [a.id];
    const fresh = [];
    for (const a of incoming) {
      if (!a.id || idsOf(a).some(id => seen.has(id))) continue;
      fresh.push(a);
      idsOf(a).forEach(id => seen.add(id));
      if (fresh.length >= 4) break;                // cap per cycle so we never spam
    }
    let shown = 0;
    const newSeenIds = [], newLog = [];
    for (const a of fresh) {
      const isWorld = a.scope === "world";
      const tag = isWorld ? "🌍 Major world news"
        : (a.urgent ? "🚨 Breaking near you" : "🔔 Local update");
      const where = isWorld ? "" : " · " + (loc ? loc.city : "");
      const entry = { id: a.id, title: a.title, publisher: a.publisher, link: a.link,
        urgent: a.urgent, scope: a.scope, published_ts: a.published_ts, ts: Date.now() };
      fireNotification(tag + where, a.title, entry);   // click → opens in-app reader
      newSeenIds.push(...idsOf(a));
      newLog.unshift(entry);
      shown++;
    }
    // Persist ONLY poll-owned fields (seen, log) against the LATEST config so we don't
    // clobber category/toggle edits the user made during the await. We deliberately do NOT
    // advance cfg.since — dedup is handled by `seen`, so a story filtered out under a narrow
    // selection can still surface later if the user broadens their topics.
    const latest = alertsCfg();
    const latestSeen = new Set(latest.seen || []);
    newSeenIds.forEach(id => latestSeen.add(id));
    latest.seen = [...latestSeen].slice(-600);
    latest.log = [...newLog, ...(latest.log || [])].slice(0, 40);
    saveAlertsCfg(latest);
    if (manual) toast(shown ? `Sent ${shown} alert${shown > 1 ? "s" : ""}` : "No new alerts right now");
    if (state.section === "alerts") renderAlerts();
  }

  function toggleWorld() {
    const cfg = alertsCfg();
    cfg.world = cfg.world === false ? true : false;
    saveAlertsCfg(cfg);
    renderAlerts();
    syncPush();                                       // keep server-side push prefs in step
    toast(cfg.world ? "🌍 World breaking news: on" : "World breaking news: off");
  }
  function toggleLocal() {
    const cfg = alertsCfg();
    cfg.local = cfg.local === false ? true : false;
    saveAlertsCfg(cfg);
    renderAlerts();
    syncPush();
    toast(cfg.local ? "📍 Local alerts: on" : "Local alerts: off");
  }

  let ALERT_TOPICS = null;                            // cached catalog [{key,label,emoji}], null until loaded
  let _topicsPromise = null;                          // in-flight fetch, shared by concurrent callers
  function loadAlertTopics() {
    if (ALERT_TOPICS) return Promise.resolve(ALERT_TOPICS);
    if (_topicsPromise) return _topicsPromise;         // dedupe concurrent loads
    _topicsPromise = api("/api/alert-topics")
      .then(r => { ALERT_TOPICS = r.topics || []; return ALERT_TOPICS; })
      .catch(() => { _topicsPromise = null; return null; });  // leave null so a later render retries
    return _topicsPromise;
  }
  function worldCatKeys() { return (ALERT_TOPICS || []).map(t => t.key); }
  // Which topic keys are currently active (undefined cfg.worldCats = all).
  function selectedWorldCats(cfg) {
    return new Set(cfg.worldCats ? cfg.worldCats : worldCatKeys());
  }
  function toggleWorldCat(key) {
    const cfg = alertsCfg();
    const all = worldCatKeys();
    const sel = selectedWorldCats(cfg);
    if (sel.has(key)) sel.delete(key); else sel.add(key);
    cfg.worldCats = (sel.size === all.length) ? undefined : [...sel];  // all selected → store as "all"
    saveAlertsCfg(cfg);
    renderAlerts();
    syncPush();
  }
  function setAllWorldCats(on) {
    const cfg = alertsCfg();
    cfg.worldCats = on ? undefined : [];              // all, or none
    saveAlertsCfg(cfg);
    renderAlerts();
    syncPush();
    toast(on ? "All world topics on" : "World topics cleared");
  }

  async function enableAlerts() {
    if (typeof Notification === "undefined") return toast("Notifications not supported on this browser");
    let perm = Notification.permission;
    if (perm !== "granted") perm = await Notification.requestPermission();
    if (perm !== "granted") return toast("Notifications blocked — allow them in your browser settings");
    await registerSW();
    const cfg = alertsCfg();
    cfg.enabled = true;
    if (cfg.world === undefined) cfg.world = true;   // default both streams on
    if (cfg.local === undefined) cfg.local = true;
    cfg.since = Date.now() / 1000;                   // only notify about stories from now on
    saveAlertsCfg(cfg);
    fireNotification("🔔 Alerts are on", "We'll ping you on breaking news near you and around the world.", null);
    startAlertsLoop();
    await syncPush();                                // background push, works app-closed
    renderAlerts();
    toast(state._pushOk ? "✓ Alerts enabled — including when the app is closed" : "✓ Alerts enabled");
  }

  function disableAlerts() {
    const cfg = alertsCfg();
    cfg.enabled = false;
    saveAlertsCfg(cfg);
    if (state._alertTimer) { clearInterval(state._alertTimer); state._alertTimer = null; }
    stopPush();                                      // also stop server-side pushes
    renderAlerts();
    toast("Alerts paused");
  }

  function startAlertsLoop() {
    if (state._alertTimer) return;
    const cfg = alertsCfg();
    if (!cfg.enabled) return;
    state._alertTimer = setInterval(() => pollAlerts(false), 5 * 60 * 1000);  // every 5 min
    setTimeout(() => pollAlerts(false), 12000);     // and once shortly after load
    syncPush();                                     // refresh push subscription + prefs on boot
  }

  function renderAlerts() {
    const c = $("#content");
    const cfg = alertsCfg();
    if (!ALERT_TOPICS) loadAlertTopics().then(t => { if (t && state.section === "alerts") renderAlerts(); });
    const loc = store.get("local", null);
    const supported = typeof Notification !== "undefined";
    const perm = supported ? Notification.permission : "unsupported";
    const on = cfg.enabled && perm === "granted";
    const statusPill = !supported ? `<span class="tag">Not supported here</span>`
      : on ? `<span class="tag" style="color:var(--green);border-color:rgba(52,211,153,.35)">🟢 On</span>`
      : perm === "denied" ? `<span class="tag" style="color:#f87171;border-color:rgba(248,113,113,.35)">Blocked in browser</span>`
      : `<span class="tag">Off</span>`;

    const dot = a => a.scope === "world" ? "🌍" : (a.urgent ? "🚨" : "🔔");
    const logRows = (cfg.log || []).length
      ? cfg.log.map((a, i) => `
          <div class="alert-row" role="button" tabindex="0" data-logi="${i}">
            <span class="alert-dot">${dot(a)}</span>
            <span class="alert-body">
              <span class="alert-title">${esc(a.title || "")}</span>
              <span class="alert-meta">${a.scope === "world" ? "🌍 World" : "📍 Local"} · ${esc(a.publisher || "")} · ${timeAgo(a.ts)}</span>
            </span>
          </div>`).join("")
      : `<div class="muted" style="padding:14px 2px">No alerts yet. When something breaks — near you or worldwide — it'll show up here.</div>`;

    const worldOn = cfg.world !== false;
    const localOn = cfg.local !== false;
    const toggle = (active, label, sub, fn) => `
      <div class="alert-toggle">
        <div><div style="font-weight:600">${label}</div><div class="muted" style="font-size:12px">${sub}</div></div>
        <button class="tb-btn ${active ? "primary" : ""}" onclick="${fn}">${active ? "On ✓" : "Off"}</button>
      </div>`;

    // World-alert category chips
    const sel = selectedWorldCats(cfg);
    const allKeys = worldCatKeys();
    const noneSel = Array.isArray(cfg.worldCats) && cfg.worldCats.length === 0;
    const catCount = !ALERT_TOPICS ? ""
      : (cfg.worldCats === undefined ? "All topics" : `${cfg.worldCats.length} of ${allKeys.length}`);
    const catChips = !ALERT_TOPICS
      ? `<span class="muted" style="font-size:12px">Loading topics…</span>`
      : ALERT_TOPICS.map(t =>
          `<button class="cat-chip ${sel.has(t.key) ? "on" : ""}" onclick="App.alerts.toggleCat('${t.key}')">${t.emoji} ${esc(t.label)}</button>`
        ).join("");
    const catFilterBlock = worldOn ? `
      <div class="cat-filter">
        <div class="cat-filter-head">
          <span class="muted" style="font-size:12px">🌍 World topics — ${catCount}</span>
          <span style="display:flex;gap:8px">
            <button class="link-btn" onclick="App.alerts.allCats(true)">All</button>
            <button class="link-btn" onclick="App.alerts.allCats(false)">None</button>
          </span>
        </div>
        <div class="cat-chips">${catChips}</div>
        ${noneSel ? `<div style="font-size:12px;margin-top:8px;color:#f87171">No topics selected — you won't get world alerts.</div>` : ""}
      </div>` : "";

    c.innerHTML = `
      <div class="page-head">
        <div><h1>🔔 News Alerts</h1>
          <p>Get notified when something big happens — near you or around the world</p></div>
        <div>${statusPill}</div>
      </div>

      <div class="alert-card" style="padding:18px;max-width:620px">
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${on
            ? `<button class="tb-btn" onclick="App.alerts.disable()">⏸ Pause all alerts</button>`
            : `<button class="tb-btn primary" onclick="App.alerts.enable()">🔔 Enable alerts</button>`}
          <button class="tb-btn" onclick="App.alerts.check()">⟳ Check now</button>
        </div>

        <div class="alert-toggles" style="margin-top:16px">
          ${toggle(worldOn, "🌍 World breaking news", "High-impact stories from across the globe", "App.alerts.toggleWorld()")}
          ${catFilterBlock}
          ${toggle(localOn, "📍 Local alerts", loc && loc.city ? `Urgent news in ${esc(loc.city)}` : "Set your city to turn this on", "App.alerts.toggleLocal()")}
        </div>

        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px">
          <span class="muted" style="font-size:13px">📍 Local city:</span>
          <span>${loc && loc.city ? esc(loc.city) : `<span class="muted">not set</span>`}</span>
          <button class="tb-btn" onclick="App.go('local')">${loc && loc.city ? "Change" : "Set location"}</button>
        </div>

        ${perm === "denied" ? `<p class="muted" style="margin-top:12px;font-size:12px;color:#f87171">
          Notifications are blocked for this site. Tap the lock/ⓘ icon in your browser's address bar → Notifications → Allow, then come back.</p>` : ""}
        <p class="muted" style="margin-top:14px;font-size:12px">
          ${state._pushOk
            ? `📡 <b>Background delivery is on</b> — alerts reach this device even when the app is closed
               (as long as the Mac server is running).`
            : `Alerts check every few minutes while the app is open. Enabling alerts also turns on
               background push where supported (Android Chrome; iPhone needs Add&nbsp;to&nbsp;Home&nbsp;Screen first).`}
        </p>
      </div>

      <h3 style="margin:22px 0 10px">Recent alerts</h3>
      <div class="alert-list" style="max-width:620px">${logRows}</div>
    `;
    // tapping a logged alert opens it in the in-app reader (not the publisher site)
    c.querySelectorAll(".alert-row[data-logi]").forEach(el => {
      el.onclick = () => openAlertStory((cfg.log || [])[+el.dataset.logi]);
    });
  }

  // In-app reader for an alert — keeps the user inside News Intel instead of
  // bouncing to the publisher. Built from the alert's own fields (alerts don't
  // carry a full clustered story object, so this is a focused headline view).
  function openAlertStory(a) {
    if (!a) return;
    if (state.section !== "alerts") go("alerts");
    const when = a.published_ts ? new Date(a.published_ts * 1000) : (a.ts ? new Date(a.ts) : null);
    const d = $("#drawer");
    d.innerHTML = `
      <div class="drawer-head">
        <h2>${esc(a.title || "")}</h2>
        <button class="close-x" onclick="App.closeDrawer()">✕</button>
      </div>
      <div class="drawer-body">
        <div class="meta" style="margin-bottom:14px">
          ${a.publisher ? `<span class="pub">${esc(a.publisher)}</span>` : ""}
          ${when ? `<span>· ${esc(when.toLocaleString())}</span>` : ""}
          <span class="tag">${a.scope === "world" ? "🌍 World" : "📍 Local"}</span>
          ${a.urgent ? `<span class="tag" style="color:#f87171;border-color:rgba(248,113,113,.35)">🚨 Breaking</span>` : ""}
        </div>
        <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
          ${a.link ? `<a class="tb-btn primary" href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener">↗ Read full article</a>` : ""}
          <button class="tb-btn" id="alRelated">🔎 Related coverage</button>
          <button class="tb-btn" id="alAsk">✦ Ask the News</button>
        </div>
        <p class="disclaimer">Breaking-news alert. See related in-app coverage from multiple sources, or open the full article at the publisher.</p>
      </div>`;
    $("#scrim").classList.add("show");
    d.classList.add("show");
    const rel = $("#alRelated"); if (rel) rel.onclick = () => { closeDrawer(); searchTerm(a.title || ""); };
    const ask = $("#alAsk"); if (ask) ask.onclick = () => {
      closeDrawer(); openAsk();
      const inp = $("#askInput"); if (inp) inp.value = a.title || "";
      runAsk();
    };
  }

  // Cold-open path: notification deep-link #alert=<id> → find it in the local log,
  // else ask the server (push-delivered alerts never entered this browser's log).
  function openAlertById(id) {
    if (!id) return;
    const a = (alertsCfg().log || []).find(x => x.id === id);
    if (a) return openAlertStory(a);
    api("/api/alert-lookup?id=" + encodeURIComponent(id))
      .then(r => {
        if (r && r.alert) openAlertStory(r.alert);
        else toast("That alert is no longer in your recent list");
      })
      .catch(() => toast("That alert is no longer in your recent list"));
  }

  function timeAgo(ts) {
    if (!ts) return "";
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  // ============================================================== Search
  let searchTimer;
  function bindSearch() {
    const inp = $("#globalSearch");
    inp.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const q = inp.value.trim();
      if (!q) return;
      searchTimer = setTimeout(() => runSearch(q), 450);
    });
    inp.addEventListener("keydown", e => { if (e.key === "Enter") runSearch(inp.value.trim()); });
  }
  function searchTerm(t) { $("#globalSearch").value = t; runSearch(t); }
  async function runSearch(q) {
    if (!q) return;
    state.section = "search";
    setActiveNav();
    addSearchHistory(q);
    const c = $("#content");
    c.innerHTML = `<div class="page-head"><div><h1>Search</h1><p>Results for “${esc(q)}” — merged across local feed + Google News</p></div></div>
      <div class="feed" id="feed">${skeletons(5)}</div>`;
    try {
      const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
      r.stories.forEach(s => state.storiesById[s.story_id] = s);
      paintStories(r.stories);
      if (!r.stories.length) $("#feed").innerHTML = emptyState(`Nothing found for “${esc(q)}”.`);
    } catch { $("#feed").innerHTML = emptyState("Search failed."); }
  }

  // ============================================================== Bookmarks / history
  function isBookmarked(id) { return !!store.get("bm", {})[id]; }
  function toggleBookmark(id, el) {
    const bm = store.get("bm", {});
    const s = state.storiesById[id];
    if (bm[id]) { delete bm[id]; toast("Removed bookmark"); }
    else if (s) { bm[id] = lite(s); toast("🔖 Bookmarked"); }
    store.set("bm", bm);
    if (el) { el.classList.toggle("on", !!bm[id]); el.textContent = bm[id] ? "🔖" : "🏷️"; }
  }
  function lite(s) {
    return { story_id: s.story_id, title: s.title, summary: s.summary, publisher: s.publisher,
      link: s.link, category: s.category, published: s.published, reliability: s.reliability,
      bias: s.bias, bias_pos: s.bias_pos, num_publishers: s.num_publishers, publishers: s.publishers,
      importance_band: s.importance_band, importance: s.importance, reading_time: s.reading_time,
      image: s.image, summaries: s.summaries, sources: s.sources, timeline: s.timeline,
      country: s.country, ownership: s.ownership, author: s.author, archive: s.archive };
  }
  function renderBookmarks() {
    const bm = Object.values(store.get("bm", {})).reverse();
    bm.forEach(s => state.storiesById[s.story_id] = s);
    $("#content").innerHTML = `<div class="page-head"><div><h1>🔖 Bookmarks</h1><p>${bm.length} saved stor${bm.length === 1 ? "y" : "ies"}</p></div></div>
      <div class="feed" id="feed">${bm.length ? bm.map(card).join("") : emptyState("No bookmarks yet. Tap 🏷️ on any story.", "🔖")}</div>`;
    bindCards($("#feed"));
  }
  function addHistory(s) {
    let h = store.get("hist", []);
    h = h.filter(x => x.story_id !== s.story_id);
    h.unshift(lite(s));
    store.set("hist", h.slice(0, 60));
  }
  function renderHistory() {
    const h = store.get("hist", []);
    h.forEach(s => state.storiesById[s.story_id] = s);
    $("#content").innerHTML = `<div class="page-head"><div><h1>🕑 History</h1><p>Recently opened — ${h.length} item${h.length === 1 ? "" : "s"}</p></div>
      ${h.length ? `<button class="tb-btn" onclick="App.clearHistory()">Clear</button>` : ""}</div>
      <div class="feed" id="feed">${h.length ? h.map(card).join("") : emptyState("Nothing read yet.", "🕑")}</div>`;
    bindCards($("#feed"));
  }
  function clearHistory() { store.set("hist", []); renderHistory(); }

  // ============================================================== Who's Watching
  async function renderVisitors() {
    $("#content").innerHTML = `
      <div class="page-head">
        <div><h1>👁️ Who's Watching</h1>
          <p>Everyone who signed in — with their selfie — plus anyone active right now</p></div>
        <div id="visSummary" style="display:flex;gap:8px"></div>
      </div>
      <div id="visList">${skeletons(3)}</div>
      <p class="disclaimer" style="margin-top:14px">Shows anyone who opens this app (including via your share link).
      IP &amp; device come from each visitor's own browser request — no accounts, no tracking cookies, and each
      person's bookmarks/history stay private to their device. Resets if the server restarts.</p>`;
    await loadVisitors();
    state._visTimer = setInterval(loadVisitors, 8000);   // live refresh
  }

  async function loadVisitors() {
    if (state.section !== "visitors") return;
    let r;
    try {
      const headers = ownerToken() ? { "X-Owner-Token": ownerToken() } : {};
      r = await fetch("/api/visitors", { headers }).then(x => x.json());
    } catch { return; }
    const sum = $("#visSummary");
    if (sum) sum.innerHTML = `
      ${r.registered ? `<span class="tag" style="font-size:12px">👤 ${r.registered} signed in</span>` : ""}
      <span class="tag" style="font-size:12px;color:var(--green);border-color:rgba(52,211,153,.3)">🟢 ${r.active} active now</span>
      <span class="tag" style="font-size:12px">📟 ${r.total} total</span>`;
    const list = $("#visList");
    if (!list) return;
    if (!r.visitors.length) { list.innerHTML = emptyState("No one has opened it yet.", "👁️"); return; }
    list.innerHTML = r.visitors.map(visitorCard).join("");
  }

  function visitorCard(v) {
    const icon = v.local ? "🖥️" : v.mobile ? "📱" : "💻";
    const who = v.name ? esc(v.name) : (v.local ? "You · this Mac" : `${esc(v.os)} · ${esc(v.browser)}`);
    const sub = v.name
      ? [esc(v.email), v.os ? `${esc(v.os)} · ${esc(v.browser)}` : null].filter(Boolean).join(" · ")
      : (v.local ? "local device" : `IP ${esc(v.ip)}`);
    const dot = v.active
      ? `<span class="status-dot"></span><span style="color:var(--green)">Active now</span>`
      : `<span class="status-dot" style="background:var(--faint);box-shadow:none"></span><span>last seen ${timeAgo(v.last * 1000)}</span>`;
    const photoQs = ownerToken() ? `?token=${encodeURIComponent(ownerToken())}` : "";
    const avatarSrc = v.avatar_url ? esc(safeUrl(v.avatar_url)) : (v.photo ? `/photo/${esc(v.photo)}.jpg${photoQs}` : null);
    const avatar = avatarSrc
      ? `<img class="visitor-photo" src="${avatarSrc}" alt="" referrerpolicy="no-referrer" onerror="this.parentNode.textContent='${icon}'">`
      : icon;
    return `
    <div class="visitor-row">
      <div class="visitor-ic">${avatar}</div>
      <div class="visitor-main">
        <div class="visitor-top"><b>${who}</b>
          ${v.name ? `<span class="tag" style="font-size:10px;color:var(--green);border-color:rgba(52,211,153,.3)">✓ signed in</span>` : ""}
          ${v.mobile ? `<span class="tag" style="font-size:10px">mobile</span>` : ""}</div>
        <div class="visitor-meta">${sub}</div>
        <div class="visitor-meta">opened ${v.opens || 1}× · browsed ${v.views} time${v.views === 1 ? "" : "s"} · first seen ${timeAgo(v.first * 1000)}</div>
      </div>
      <div class="visitor-status">${dot}</div>
    </div>`;
  }
  function addSearchHistory(q) {
    let s = store.get("searches", []);
    s = [q, ...s.filter(x => x !== q)].slice(0, 12);
    store.set("searches", s);
  }

  // ============================================================== Ask
  function openAsk() {
    $("#askScrim").classList.add("show");
    $("#askInput").focus();
    $("#askSuggest").innerHTML = [
      "What happened in markets today?", "Latest on AI", "Top India news",
      "Any breaking world news?", "What's new in space?",
    ].map(q => `<button class="chip" onclick="App.askThis('${esc(q)}')">${esc(q)}</button>`).join("");
  }
  function closeAsk() { $("#askScrim").classList.remove("show"); }
  function askThis(q) { $("#askInput").value = q; runAsk(); }
  async function runAsk() {
    const q = $("#askInput").value.trim();
    if (!q) return;
    const res = $("#askResult");
    res.innerHTML = `<div class="ask-answer"><span class="spin"></span> Searching the live feed…</div>`;
    try {
      const r = await api(`/api/ask?q=${encodeURIComponent(q)}`);
      res.innerHTML = `<div class="ask-answer">${esc(r.answer)}</div>
        ${r.citations.length ? `<div style="margin-top:14px"><div class="sec-title" style="margin-top:0">Sources</div>
        ${r.citations.map(c => `<a class="cite" href="${esc(safeUrl(c.link))}" target="_blank" rel="noopener">
          <span class="n">[${c.n}]</span>
          <span><b>${esc(c.title)}</b><br><span style="color:var(--muted)">${esc(c.publisher)} · ${c.published ? timeAgo(c.published) : ""} · reliability ${c.reliability || "—"}/100</span></span>
        </a>`).join("")}</div>` : ""}`;
    } catch { res.innerHTML = `<div class="ask-answer">Something went wrong. Try again.</div>`; }
  }

  // ============================================================== Filters UI
  function filterBar({ showCats, extra } = {}) {
    const cats = (state.meta?.categories || []);
    return `<div class="filters">
      ${showCats ? `<div class="chips-scroll" id="catChips">
        <button class="chip ${!state.category ? "active" : ""}" data-cat="">All</button>
        ${cats.map(c => `<button class="chip ${state.category === c ? "active" : ""}" data-cat="${c}">${c}</button>`).join("")}
      </div>` : ""}
      <select class="f-select" id="sortSel">
        <option value="time">Latest</option>
        <option value="importance">Importance</option>
        <option value="publishers">Most sources</option>
      </select>
      <select class="f-select" id="timeSel">
        <option value="">Any time</option>
        <option value="1">Past hour</option>
        <option value="6">Past 6h</option>
        <option value="24">Past 24h</option>
        <option value="72">Past 3 days</option>
      </select>
      <select class="f-select" id="biasSel">
        <option value="">Any lean</option>
        <option value="center">Center</option>
        <option value="center-left">Center-left</option>
        <option value="center-right">Center-right</option>
        <option value="left">Left</option>
        <option value="right">Right</option>
      </select>
      <div class="f-slider">Min reliability <input type="range" id="relSlider" min="0" max="95" step="5" value="${state.minRel}"><span id="relVal">${state.minRel}</span></div>
      ${extra || ""}
    </div>`;
  }
  function bindFilters() {
    const cc = $("#catChips");
    if (cc) cc.addEventListener("click", e => {
      const b = e.target.closest(".chip"); if (!b) return;
      state.category = b.dataset.cat || null; state.page = 0;
      $$("#catChips .chip").forEach(x => x.classList.remove("active")); b.classList.add("active");
      reloadFeed();
    });
    const sort = $("#sortSel"); if (sort) { sort.value = state.sort; sort.onchange = () => { state.sort = sort.value; state.page = 0; reloadFeed(); }; }
    const time = $("#timeSel"); if (time) time.onchange = () => { state.hours = time.value || null; state.page = 0; reloadFeed(); };
    const bias = $("#biasSel"); if (bias) bias.onchange = () => { state.bias = bias.value; state.page = 0; reloadFeed(); };
    const rel = $("#relSlider"); if (rel) rel.oninput = () => { state.minRel = +rel.value; $("#relVal").textContent = rel.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.page = 0; reloadFeed(); }, 300); };
  }
  function reloadFeed() {
    $("#feed").innerHTML = skeletons(5);
    loadFeed(state._lastExtra || {});
  }

  // ============================================================== Command palette
  let palItems = [], palSel = 0;
  function buildPalette() {
    const inp = $("#paletteInput");
    inp.addEventListener("input", () => renderPalette(inp.value));
    inp.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") { palSel = Math.min(palSel + 1, palItems.length - 1); paintPalette(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { palSel = Math.max(palSel - 1, 0); paintPalette(); e.preventDefault(); }
      else if (e.key === "Enter") { palItems[palSel]?.run(); closePalette(); }
      else if (e.key === "Escape") closePalette();
    });
  }
  function openPalette() {
    $("#paletteScrim").classList.add("show");
    $("#paletteInput").value = ""; $("#paletteInput").focus();
    renderPalette("");
  }
  function closePalette() { $("#paletteScrim").classList.remove("show"); }
  function renderPalette(q) {
    q = q.toLowerCase();
    const base = [];
    NAV.forEach(g => g.items.forEach(it => base.push({ icon: it.icon, label: it.label, hint: g.group, run: () => go(it.id) })));
    (state.meta?.categories || []).forEach(c => base.push({ icon: "🏷️", label: c, hint: "Category", run: () => { go("cat:" + c); } }));
    if (q) base.unshift({ icon: "🔍", label: `Search “${q}”`, hint: "Search", run: () => searchTerm(q) },
                        { icon: "✦", label: `Ask “${q}”`, hint: "Ask", run: () => { openAsk(); $("#askInput").value = q; runAsk(); } });
    palItems = base.filter(x => !q || x.label.toLowerCase().includes(q) || x.hint.toLowerCase().includes(q)).slice(0, 12);
    palSel = 0; paintPalette();
  }
  function paintPalette() {
    $("#paletteList").innerHTML = palItems.map((it, i) =>
      `<div class="pal-item ${i === palSel ? "sel" : ""}" data-i="${i}"><span class="ic">${it.icon}</span>${esc(it.label)}<small>${esc(it.hint)}</small></div>`).join("");
    $$("#paletteList .pal-item").forEach(el => { el.onclick = () => { palItems[el.dataset.i].run(); closePalette(); }; });
  }

  // ============================================================== TTS
  function listen(s) {
    if (!s || !window.speechSynthesis) return toast("Speech not supported");
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(`${s.title}. ${s.summaries?.twomin || s.summary}`);
    u.rate = 1.02;
    window.speechSynthesis.speak(u);
    toast("🔊 Reading aloud… (Esc to stop)");
  }

  // ============================================================== Theme + keys
  function applyTheme(t) {
    document.documentElement.classList.toggle("light", t === "light");
    $("#themeBtn").textContent = t === "light" ? "☀️" : "🌙";
  }
  function toggleTheme() {
    const t = document.documentElement.classList.contains("light") ? "dark" : "light";
    store.set("theme", t); applyTheme(t);
  }
  function bindKeys() {
    document.addEventListener("keydown", e => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); openPalette(); }
      else if (e.key === "Escape") { closeDrawer(); closePalette(); closeAsk(); closeSheet(); window.speechSynthesis?.cancel(); }
      else if (e.key === "/" && document.activeElement.tagName !== "INPUT") { e.preventDefault(); $("#globalSearch").focus(); }
      else if (state.section === "shorts" && !anyOverlayOpen() && document.activeElement.tagName !== "INPUT" && (e.key === "ArrowDown" || e.key === "j")) { shortsNav(1); e.preventDefault(); }
      else if (state.section === "shorts" && !anyOverlayOpen() && document.activeElement.tagName !== "INPUT" && (e.key === "ArrowUp" || e.key === "k")) { shortsNav(-1); e.preventDefault(); }
      else if (!e.metaKey && !e.ctrlKey && document.activeElement.tagName !== "INPUT") {
        const map = { h: "home", s: "shorts", b: "breaking", t: "trending", w: "world", i: "india", l: "local", m: "map" };
        if (map[e.key]) go(map[e.key]);
        if (e.key === "a") openAsk();
        if (e.key === "r") refreshNews();
      }
    });
  }

  // ============================================================== helpers
  function skeletons(n) {
    return Array(n).fill(0).map(() => `<div class="skel"><div class="sk" style="height:14px;width:30%;margin-bottom:12px"></div><div class="sk" style="height:22px;width:85%;margin-bottom:10px"></div><div class="sk" style="height:14px;width:95%;margin-bottom:6px"></div><div class="sk" style="height:14px;width:60%"></div></div>`).join("");
  }
  function railSkeleton() { return `<div class="panel">${skeletons(1)}</div>`; }
  function trendsPanel(trends, title = "🔥 Trending now") {
    return `<div class="panel"><h4>${title}</h4>${
      trends.slice(0, 12).map((t, i) => `<div class="trend-row" data-term="${esc(t.term)}" onclick="App.searchTerm('${esc(t.term)}')">
        <span class="trank">${t.hot ? "🔥" : i + 1}</span>
        <span class="tterm">${esc(t.term)}</span>
        <span class="tgrow ${t.growth <= 0 ? "down" : ""}">${t.recent}↑</span>
      </div>`).join("") || `<p class="disclaimer">Gathering trends…</p>`}</div>`;
  }
  function emptyState(msg, icon = "📭") {
    return `<div class="empty"><div class="big">${icon}</div>${esc(msg)}</div>`;
  }
  function anyOverlayOpen() {
    return $("#drawer").classList.contains("show") ||
           $("#paletteScrim").classList.contains("show") ||
           $("#askScrim").classList.contains("show");
  }
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2200);
  }
  function timeAgo(d) {
    const ts = typeof d === "number" ? d : new Date(d).getTime();
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  // expose
  return { boot, go, more, openAsk, closeAsk, runAsk, askThis, toggleTheme, closeDrawer,
    searchTerm, clearHistory, refreshNews, closeSheet,
    alerts: { enable: enableAlerts, disable: disableAlerts, check: () => pollAlerts(true),
      toggleWorld, toggleLocal, toggleCat: toggleWorldCat, allCats: setAllWorldCats } };
})();

document.addEventListener("DOMContentLoaded", App.boot);
