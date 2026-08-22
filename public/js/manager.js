/* ===========================================================================
   Anand Palace — Reception / Manager dashboard (multi-tenant)
   Tabs: Live Orders · Menu editor · Analytics · Tables & QR · Settings
   =========================================================================== */
(() => {
  const root = document.getElementById("root");
  const printArea = document.getElementById("printArea");

  const slugFromPath = () => {
    const m = location.pathname.match(/^\/r\/([^/]+)\/manager/);
    return m ? m[1] : null;
  };

  const state = {
    authed: false,
    slug: slugFromPath(),
    restaurant: null,
    payments: {},
    tab: "orders",
    orders: [],
    ordersView: "live",   // "live" | "cleared"
    clearedOrders: [],
    clearedCount: 0,
    stats: {},
    tables: [],
    menuDraft: null,
    analytics: null,
    socket: null,
    flashId: null // id of the order to briefly highlight after a live change
  };

  const rupees = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || "Error"); e.status = res.status; throw e; }
    return data;
  }

  function timeAgo(ts) {
    if (!ts) return "";
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    return Math.floor(m / 60) + "h ago";
  }

  // ========================================================================
  // LOGIN
  // ========================================================================
  function renderLogin(errMsg = "") {
    root.innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <div class="emblem">🏰</div>
          <h1>${esc(state.restaurant ? state.restaurant.name : "Reception")}</h1>
          <div class="sub">MANAGER DASHBOARD</div>
          <label for="pw">Manager Password</label>
          <input id="pw" type="password" placeholder="Enter password" autocomplete="current-password" />
          <button class="btn" id="loginBtn">Sign In</button>
          <div class="login-err">${esc(errMsg)}</div>
        </div>
      </div>`;
    const pw = root.querySelector("#pw");
    const btn = root.querySelector("#loginBtn");
    const submit = async () => {
      btn.disabled = true;
      try {
        const r = await api("/api/manager/login", { method: "POST", body: { slug: state.slug || undefined, password: pw.value } });
        state.authed = true;
        state.restaurant = r.restaurant;
        await loadAll();
        connectSocket();
        renderShell();
      } catch (e) {
        renderLogin(e.message || "Login failed");
        root.querySelector("#pw").focus();
      }
    };
    btn.onclick = submit;
    pw.addEventListener("keydown", (e) => e.key === "Enter" && submit());
    pw.focus();
  }

  // ========================================================================
  // DATA
  // ========================================================================
  async function loadOrders() { const d = await api("/api/manager/orders"); state.orders = d.orders; state.stats = d.stats; state.clearedCount = d.clearedCount || 0; }
  async function loadTables() { state.tables = (await api("/api/manager/tables")).tables; }
  async function loadMenu() { state.menuDraft = (await api("/api/manager/menu")).categories; }
  async function loadAnalytics() { state.analytics = await api("/api/manager/analytics"); }
  async function loadAll() { await loadOrders(); }

  // ========================================================================
  // SHELL
  // ========================================================================
  const TABS = [
    { id: "orders", label: "📋 Orders" },
    { id: "menu", label: "🍽️ Menu" },
    { id: "analytics", label: "📊 Analytics" },
    { id: "tables", label: "🔳 Tables & QR" },
    { id: "settings", label: "⚙️ Settings" }
  ];

  function renderShell() {
    root.innerHTML = `
      <div class="topbar">
        <div class="brand">
          <span class="e">🏰</span>
          <span><b>${esc(state.restaurant ? state.restaurant.name : "Anand Palace")}</b><small>Manager</small></span>
        </div>
        <span class="live"><span class="pulse"></span> Live</span>
        <div class="spacer"></div>
        <button class="logout" id="logoutBtn">Sign out</button>
      </div>
      <div class="stats" id="stats"></div>
      <div class="tabs">
        ${TABS.map((t) => `<button class="tab ${state.tab === t.id ? "active" : ""}" data-tab="${t.id}">${t.label}</button>`).join("")}
      </div>
      <div class="content" id="content"></div>`;
    root.querySelector("#logoutBtn").onclick = logout;
    root.querySelectorAll(".tab").forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));
    renderStats();
    renderContent();
  }

  function renderStats() {
    const s = state.stats || {};
    const el = root.querySelector("#stats");
    if (!el) return;
    el.innerHTML = `
      <div class="stat"><div class="v">${s.totalOrders || 0}</div><div class="l">Total orders</div></div>
      <div class="stat"><div class="v">${s.activeOrders || 0}</div><div class="l">Active orders</div></div>
      <div class="stat"><div class="v">${s.activeTables || 0}</div><div class="l">Tables seated</div></div>
      <div class="stat"><div class="v">${rupees(s.pendingRevenue || 0)}</div><div class="l">Pending revenue</div></div>
      <div class="stat"><div class="v">${rupees(s.collected || 0)}</div><div class="l">Collected</div></div>`;
  }

  async function switchTab(tab) {
    state.tab = tab;
    try {
      if (tab === "tables") await loadTables();
      if (tab === "menu") await loadMenu();
      if (tab === "analytics") await loadAnalytics();
    } catch (e) { if (e.status === 401) return forceLogin(); }
    renderShell();
  }

  function renderContent() {
    if (state.tab === "orders") renderOrders();
    else if (state.tab === "menu") renderMenuEditor(state.menuDraft || []);
    else if (state.tab === "analytics") renderAnalytics();
    else if (state.tab === "tables") renderTables();
    else if (state.tab === "settings") renderSettings();
  }

  // ========================================================================
  // ORDERS BOARD
  // ========================================================================
  const NEXT = { placed: "preparing", preparing: "ready", ready: "served", served: "paid" };
  const NEXT_LABEL = {
    placed: "👨‍🍳 Start preparing", preparing: "🔔 Mark Ready (notify guest)",
    ready: "🍽️ Mark served", served: "💰 Collect payment"
  };

  function renderOrders() {
    const el = root.querySelector("#content");

    // ---- Cleared / history view ----
    if (state.ordersView === "cleared") {
      const list = state.clearedOrders || [];
      el.innerHTML = `
        <div class="orders-toolbar">
          <button class="ot-btn" id="backLiveBtn">← Back to live board</button>
          <span class="ot-hint">🗂️ Cleared orders — history only (still counted in Analytics)</span>
        </div>
        ${list.length
          ? `<div class="board">${list.map((o) => orderCard(o, true)).join("")}</div>`
          : `<div class="empty-board"><div class="e">🗂️</div><h3>No cleared orders</h3><p>Orders you clear from the live board are kept here.</p></div>`}`;
      root.querySelector("#backLiveBtn").onclick = () => { state.ordersView = "live"; renderContent(); };
      wireOrders();
      return;
    }

    // ---- Live board ----
    const live = state.orders.filter((o) => o.status !== "paid" && o.status !== "cancelled");
    const done = state.orders.filter((o) => o.status === "paid" || o.status === "cancelled");
    const toolbar = `
      <div class="orders-toolbar">
        <button class="ot-btn" id="viewClearedBtn">🗂️ Cleared (${state.clearedCount || 0})</button>
        <button class="ot-btn danger" id="clearBoardBtn" ${state.orders.length ? "" : "disabled"}>🧹 Clear board</button>
      </div>`;
    el.innerHTML = `
      ${toolbar}
      ${state.orders.length === 0
        ? `<div class="empty-board"><div class="e">🍽️</div><h3>No orders on the board</h3><p>New orders appear here instantly. Cleared orders stay under “Cleared”.</p></div>`
        : `<div class="board">${live.map((o) => orderCard(o)).join("")}</div>
           ${done.length ? `<h3 style="margin:26px 0 12px;color:var(--muted)">Completed</h3><div class="board">${done.map((o) => orderCard(o)).join("")}</div>` : ""}`}`;
    state.flashId = null; // one-shot highlight; consumed on render
    root.querySelector("#viewClearedBtn").onclick = showCleared;
    const cb = root.querySelector("#clearBoardBtn");
    if (cb) cb.onclick = clearBoard;
    wireOrders();
  }

  async function showCleared() {
    try {
      const d = await api("/api/manager/orders?cleared=1");
      state.clearedOrders = d.orders;
      state.clearedCount = d.clearedCount || d.orders.length;
      state.ordersView = "cleared";
      renderContent();
    } catch (e) { if (e.status === 401) return forceLogin(); flash("⚠️ " + e.message, true); }
  }

  async function clearBoard() {
    const n = state.orders.length;
    const active = state.orders.filter((o) => o.status !== "paid" && o.status !== "cancelled").length;
    const warn = active
      ? `Clear ALL ${n} orders from the board — including ${active} still in progress?\n\nThey stay viewable under “Cleared” and in Analytics.`
      : `Clear all ${n} orders from the board?\n\nThey stay viewable under “Cleared” and in Analytics.`;
    if (!window.confirm(warn)) return;
    try {
      const d = await api("/api/manager/orders/clear", { method: "POST" });
      await loadOrders();
      state.ordersView = "live";
      renderStats();
      renderContent();
      flash(`🧹 Cleared ${d.cleared} order${d.cleared === 1 ? "" : "s"} from the board`);
    } catch (e) { if (e.status === 401) return forceLogin(); flash("⚠️ " + e.message, true); }
  }

  function orderCard(o, archived) {
    const items = o.items.map((i) => `<div class="oc-item"><span class="q">${i.qty}×</span><span class="nm">${i.emoji || ""} ${esc(i.name)}</span><span class="pr">${rupees(i.price * i.qty)}</span></div>`).join("");
    const next = NEXT[o.status];
    const live = !archived && o.status !== "paid" && o.status !== "cancelled";
    const actions = !live ? "" : `
        <div class="oc-actions">
          ${next ? `<button class="act-primary ${next === "ready" ? "act-ready" : ""}" data-act="status" data-id="${o.id}" data-to="${next}">${NEXT_LABEL[o.status]}</button>` : ""}
          ${o.status === "served" ? `<button class="act-pay" data-act="status" data-id="${o.id}" data-to="paid">💰 Paid</button>` : ""}
          <button class="act-kot" data-act="kot" data-id="${o.id}">🖨️ KOT</button>
          <button class="act-cancel" data-act="status" data-id="${o.id}" data-to="cancelled">Cancel</button>
        </div>`;
    const bill = o.bill ? `<div class="oc-bill"><span>🧾 ${esc(o.bill.invoiceNo)} · ${esc((o.bill.method || "").toUpperCase())}</span><span>${rupees(o.bill.total)} <small>incl. GST</small></span></div>` : "";
    const feedback = o.feedback
      ? `<div class="oc-feedback"><span class="ocf-stars">${"★".repeat(o.feedback.rating)}${"☆".repeat(5 - o.feedback.rating)}</span>${o.feedback.comment ? `<span class="ocf-text">“${esc(o.feedback.comment)}”</span>` : ""}</div>`
      : "";
    // Guest changed the order after placing it (only possible until "Start preparing").
    const edited = o.status === "placed" && o.edited;
    const flash = o.id === state.flashId ? " just-updated" : "";
    return `
      <div class="order-card s-${o.status}${flash}">
        <div class="oc-head">
          <span class="oc-table">${esc(o.tableName)}</span>
          <span class="oc-guest">#${esc(o.guest)}</span>
          ${edited ? `<span class="oc-edited">✏️ edited ${timeAgo(o.editedAt || o.updatedAt)}</span>` : ""}
          <span class="oc-time">${timeAgo(o.placedAt || o.createdAt)}</span>
        </div>
        <span class="badge b-${o.status}">${o.status}</span>
        <div class="oc-items">${items}</div>
        <div class="oc-total"><span>Total (${o.itemCount} items)</span><span>${rupees(o.total)}</span></div>
        ${bill}${feedback}${actions}
      </div>`;
  }

  function wireOrders() {
    root.querySelectorAll('[data-act="status"]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          await api(`/api/manager/orders/${b.dataset.id}/status`, { method: "POST", body: { status: b.dataset.to } });
          await loadOrders(); renderStats(); renderContent();
        } catch (e) { if (e.status === 401) return forceLogin(); b.disabled = false; }
      };
    });
    root.querySelectorAll('[data-act="kot"]').forEach((b) => {
      b.onclick = () => { const o = state.orders.find((x) => x.id === b.dataset.id); if (o) printKOT(o); };
    });
  }

  // ---- KOT (Kitchen Order Ticket) ----
  function printKOT(o) {
    const when = new Date(o.placedAt || o.createdAt).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" });
    printArea.innerHTML = `
      <div class="kot">
        <div class="kot-h">KITCHEN ORDER TICKET</div>
        <div class="kot-rest">${esc(state.restaurant ? state.restaurant.name : "")}</div>
        <div class="kot-meta"><span>${esc(o.tableName)}</span><span>#${esc(o.guest)}</span></div>
        <div class="kot-meta"><span>${when}</span><span>KOT-${esc(o.id.slice(0, 6).toUpperCase())}</span></div>
        <div class="kot-line"></div>
        ${o.items.map((i) => `<div class="kot-item"><span class="kq">${i.qty}×</span><span class="kn">${esc(i.name)}</span></div>`).join("")}
        <div class="kot-line"></div>
        <div class="kot-foot">${o.itemCount} items · prepare & ring when ready</div>
      </div>`;
    window.print();
  }

  // ========================================================================
  // MENU EDITOR
  // ========================================================================
  function renderMenuEditor(menu) {
    const el = root.querySelector("#content");
    el.innerHTML = `
      <div class="menu-editor-bar">
        <div class="hint">Edit dishes, prices, photos & badges. Guests see changes instantly after you save.</div>
        <div class="me-actions">
          <button class="btn ghost" id="addCat">+ Add category</button>
          <button class="btn" id="saveMenu">💾 Save menu</button>
        </div>
      </div>
      <div id="meList">${menu.map(catEditor).join("")}</div>`;

    el.querySelector("#addCat").onclick = () => {
      const m = scrapeMenu();
      m.push({ name: "New Category", icon: "🍽️", tagline: "", items: [] });
      state.menuDraft = m; renderContent();
    };
    el.querySelector("#saveMenu").onclick = saveMenu;
    wireMenuEditor();
  }

  function catEditor(c, ci) {
    return `
      <div class="me-cat" data-ci="${ci}">
        <div class="me-cat-head">
          <input class="me-icon" value="${esc(c.icon || "🍽️")}" maxlength="4" title="Icon emoji" />
          <input class="me-cat-name" value="${esc(c.name)}" placeholder="Category name" />
          <input class="me-cat-tag" value="${esc(c.tagline || "")}" placeholder="Short tagline (optional)" />
          <button class="me-del-cat" data-ci="${ci}" title="Delete category">✕</button>
        </div>
        <div class="me-items">
          ${(c.items || []).map((it, ii) => itemEditor(it, ci, ii)).join("")}
        </div>
        <button class="me-add-item btn ghost" data-ci="${ci}">+ Add dish</button>
      </div>`;
  }

  function itemEditor(it, ci, ii) {
    const chk = (on, cls, label) => `<label class="me-chk"><input type="checkbox" class="${cls}" ${on ? "checked" : ""}/> ${label}</label>`;
    return `
      <div class="me-item" data-ci="${ci}" data-ii="${ii}">
        <div class="me-row1">
          <input class="me-emoji" value="${esc(it.emoji || "🍽️")}" maxlength="4" title="Emoji" />
          <input class="me-name" value="${esc(it.name)}" placeholder="Dish name" />
          <input class="me-price" type="number" min="0" value="${Number(it.price) || 0}" title="Price ₹" />
          <button class="me-del-item" data-ci="${ci}" data-ii="${ii}" title="Remove dish">✕</button>
        </div>
        <input class="me-img" value="${esc(it.img || "")}" placeholder="Photo URL (optional)" />
        <input class="me-desc" value="${esc(it.desc || "")}" placeholder="Description (optional)" />
        <div class="me-flags">
          ${chk(it.veg !== false, "me-veg", "🟢 Veg")}
          ${chk((it.badges || []).includes("spicy"), "me-spicy", "🌶️ Spicy")}
          ${chk((it.badges || []).includes("gf"), "me-gf", "GF")}
          ${chk(it.bestseller, "me-best", "⭐ Bestseller")}
          ${chk(it.special, "me-special", "👑 Special")}
        </div>
      </div>`;
  }

  function scrapeMenu() {
    const cats = [];
    root.querySelectorAll(".me-cat").forEach((catEl) => {
      const c = {
        icon: catEl.querySelector(".me-icon").value,
        name: catEl.querySelector(".me-cat-name").value,
        tagline: catEl.querySelector(".me-cat-tag").value,
        items: []
      };
      catEl.querySelectorAll(".me-item").forEach((itEl) => {
        c.items.push({
          emoji: itEl.querySelector(".me-emoji").value,
          name: itEl.querySelector(".me-name").value,
          price: Number(itEl.querySelector(".me-price").value) || 0,
          img: itEl.querySelector(".me-img").value,
          desc: itEl.querySelector(".me-desc").value,
          veg: itEl.querySelector(".me-veg").checked,
          badges: [
            itEl.querySelector(".me-spicy").checked ? "spicy" : null,
            itEl.querySelector(".me-gf").checked ? "gf" : null
          ].filter(Boolean),
          bestseller: itEl.querySelector(".me-best").checked,
          special: itEl.querySelector(".me-special").checked
        });
      });
      cats.push(c);
    });
    return cats;
  }

  function wireMenuEditor() {
    root.querySelectorAll(".me-add-item").forEach((b) => {
      b.onclick = () => {
        const m = scrapeMenu();
        m[Number(b.dataset.ci)].items.push({ name: "", price: 0, emoji: "🍽️", veg: true, badges: [] });
        state.menuDraft = m; renderContent();
      };
    });
    root.querySelectorAll(".me-del-item").forEach((b) => {
      b.onclick = () => {
        const m = scrapeMenu();
        m[Number(b.dataset.ci)].items.splice(Number(b.dataset.ii), 1);
        state.menuDraft = m; renderContent();
      };
    });
    root.querySelectorAll(".me-del-cat").forEach((b) => {
      b.onclick = () => {
        const m = scrapeMenu(); m.splice(Number(b.dataset.ci), 1);
        state.menuDraft = m; renderContent();
      };
    });
  }

  async function saveMenu() {
    const categories = scrapeMenu();
    try {
      const r = await api("/api/manager/menu", { method: "PUT", body: { categories } });
      state.menuDraft = r.categories;
      flash("✅ Menu saved — live for guests now");
      renderContent();
    } catch (e) { if (e.status === 401) return forceLogin(); flash("⚠️ " + e.message, true); }
  }

  // ========================================================================
  // ANALYTICS
  // ========================================================================
  function renderAnalytics() {
    const el = root.querySelector("#content");
    const a = state.analytics;
    if (!a) { el.innerHTML = `<div class="empty-board"><div class="e">📊</div><h3>Loading…</h3></div>`; return; }
    if (!a.totals.orders) {
      el.innerHTML = `<div class="empty-board"><div class="e">📊</div><h3>No sales yet</h3><p>Once guests pay, you’ll see bestsellers, busy hours and revenue trends here.</p></div>`;
      return;
    }
    const maxDay = Math.max(1, ...a.days.map((d) => d.revenue));
    const maxItem = Math.max(1, ...a.topItems.map((i) => i.qty));
    el.innerHTML = `
      <div class="an-cards">
        <div class="an-card"><div class="v">${rupees(a.totals.revenue)}</div><div class="l">Total collected</div></div>
        <div class="an-card"><div class="v">${a.totals.orders}</div><div class="l">Paid orders</div></div>
        <div class="an-card"><div class="v">${rupees(a.totals.avgOrder)}</div><div class="l">Avg. order value</div></div>
      </div>
      <div class="an-block">
        <h3>Revenue · last 7 days</h3>
        <div class="bars">
          ${a.days.map((d) => `<div class="bar-col"><div class="bar" style="height:${Math.round((d.revenue / maxDay) * 100)}%" title="${rupees(d.revenue)}"></div><span>${esc(d.day)}</span></div>`).join("")}
        </div>
      </div>
      <div class="an-block">
        <h3>Bestselling dishes</h3>
        ${a.topItems.map((i) => `
          <div class="top-row">
            <span class="ti-name">${i.emoji || ""} ${esc(i.name)}</span>
            <div class="ti-bar-wrap"><div class="ti-bar" style="width:${Math.round((i.qty / maxItem) * 100)}%"></div></div>
            <span class="ti-qty">${i.qty} sold · ${rupees(i.revenue)}</span>
          </div>`).join("")}
      </div>
      <div class="an-block">
        <h3>Payment methods</h3>
        <div class="methods">${Object.entries(a.methods).map(([m, n]) => `<span class="mtag">${esc(m.toUpperCase())} · ${n}</span>`).join("") || "—"}</div>
      </div>`;
  }

  // ========================================================================
  // TABLES & QR
  // ========================================================================
  function renderTables() {
    const el = root.querySelector("#content");
    el.innerHTML = `
      <div class="tables-toolbar">
        <label>Number of tables</label>
        <input id="tableCount" type="number" min="1" max="100" value="${state.tables.length || 12}" />
        <button class="btn" id="saveTables">Update</button>
        <button class="btn" id="printAll" style="background:var(--saffron)">🖨️ Print all QR</button>
        <span class="hint">Print these QR codes and place one on each table. Open this dashboard from your Wi-Fi address so codes work on phones.</span>
      </div>
      <div class="qr-grid">
        ${state.tables.map((t) => `
          <div class="qr-card">
            <img src="${t.qr}" alt="QR for ${esc(t.name)}" />
            <div class="qt">${esc(t.name)}</div>
            <div class="qu">${esc(t.url)}</div>
            <button class="qprint" data-id="${t.id}">Print this</button>
          </div>`).join("")}
      </div>`;
    el.querySelector("#saveTables").onclick = async () => {
      const count = parseInt(el.querySelector("#tableCount").value, 10);
      try { await api("/api/manager/tables", { method: "POST", body: { count } }); await loadTables(); renderContent(); }
      catch (e) { if (e.status === 401) return forceLogin(); }
    };
    el.querySelector("#printAll").onclick = () => printQRs(state.tables);
    el.querySelectorAll(".qprint").forEach((b) => (b.onclick = () => printQRs(state.tables.filter((t) => String(t.id) === b.dataset.id))));
  }

  function printQRs(tables) {
    const name = state.restaurant ? state.restaurant.name : "Anand Palace";
    printArea.innerHTML = tables.map((t) => `
      <div class="print-card">
        <div style="font-family:'Playfair Display',serif;font-size:34px;color:#3a0a0a">🏰 ${esc(name)}</div>
        <img src="${t.qr}" alt="QR" />
        <h2>${esc(t.name)}</h2>
        <p>Scan to view our menu & order from your seat</p>
      </div>`).join("");
    window.print();
  }

  // ========================================================================
  // SETTINGS
  // ========================================================================
  function renderSettings() {
    const el = root.querySelector("#content");
    const r = state.restaurant || {};
    const field = (k, label, val, ph = "") => `<label class="set-field"><span>${label}</span><input data-set="${k}" value="${esc(val || "")}" placeholder="${esc(ph)}" /></label>`;
    el.innerHTML = `
      <div class="settings-wrap">
        <div class="hint">These appear on the guest app and the GST receipt.</div>
        ${field("name", "Restaurant name", r.name)}
        ${field("tagline", "Tagline", r.tagline)}
        ${field("address", "Address", r.address)}
        ${field("phone", "Phone", r.phone)}
        ${field("gstin", "GSTIN", r.gstin)}
        ${field("fssai", "FSSAI", r.fssai)}
        ${field("reviewUrl", "Google review link", r.reviewUrl, "https://search.google.com/local/writereview?placeid=…")}
        <label class="set-field"><span>New manager password (optional)</span><input data-set="managerPassword" type="text" placeholder="leave blank to keep current" /></label>
        <button class="btn" id="saveSettings">💾 Save settings</button>
      </div>`;
    el.querySelector("#saveSettings").onclick = async () => {
      const body = {};
      el.querySelectorAll("[data-set]").forEach((i) => { if (i.value !== "" || i.dataset.set !== "managerPassword") body[i.dataset.set] = i.value; });
      try {
        const resp = await api("/api/manager/restaurant", { method: "PUT", body });
        state.restaurant = resp.restaurant;
        flash("✅ Settings saved");
        renderShell();
      } catch (e) { if (e.status === 401) return forceLogin(); flash("⚠️ " + e.message, true); }
    };
  }

  // ========================================================================
  // FLASH / LIVE / AUTH
  // ========================================================================
  let flashTimer;
  function flash(msg, err = false) {
    let el = document.getElementById("mgr-flash");
    if (!el) { el = document.createElement("div"); el.id = "mgr-flash"; el.className = "mgr-flash"; document.body.appendChild(el); }
    el.textContent = msg; el.className = "mgr-flash show" + (err ? " err" : "");
    clearTimeout(flashTimer); flashTimer = setTimeout(() => (el.className = "mgr-flash"), 2600);
  }

  function connectSocket() {
    if (state.socket) return;
    const socket = io();
    state.socket = socket;
    socket.on("order:changed", (order) => {
      // Only act on the manager-shaped payload. (A browser that also holds a
      // guest session would otherwise receive the guest's customerView, which
      // has no itemCount, and clobber the card.)
      if (!order || !order.tableName || order.itemCount === undefined) return;
      // Cleared/archived orders never return to the live board on later updates.
      if (order.cleared) { state.orders = state.orders.filter((o) => o.id !== order.id); if (state.tab === "orders" && state.ordersView === "live") renderContent(); return; }
      const idx = state.orders.findIndex((o) => o.id === order.id);
      const prev = idx >= 0 ? state.orders[idx] : null;
      if (idx >= 0) state.orders[idx] = order; else state.orders.unshift(order);
      state.flashId = order.id;
      recomputeStats(); renderStats();
      if (state.tab === "orders") renderContent();
      // Guest edited an already-placed order — make it impossible to miss.
      if (prev && order.status === "placed" && (prev.total !== order.total || prev.itemCount !== order.itemCount)) {
        flash(`✏️ ${order.tableName} updated their order — now ${order.itemCount} items · ${rupees(order.total)}`);
      }
    });
  }

  function recomputeStats() {
    const active = state.orders.filter((o) => o.status !== "paid" && o.status !== "cancelled");
    state.stats = {
      totalOrders: state.orders.length,
      activeOrders: active.length,
      activeTables: new Set(active.map((o) => o.tableId)).size,
      pendingRevenue: active.reduce((s, o) => s + o.total, 0),
      collected: state.orders.filter((o) => o.status === "paid").reduce((s, o) => s + (o.bill ? o.bill.total : o.total), 0)
    };
  }

  async function logout() {
    try { await api("/api/manager/logout", { method: "POST" }); } catch {}
    state.authed = false;
    if (state.socket) { state.socket.disconnect(); state.socket = null; }
    renderLogin();
  }
  function forceLogin() { state.authed = false; renderLogin("Session expired. Please sign in again."); }

  async function boot() {
    try {
      const s = await api("/api/manager/session");
      state.authed = true; state.restaurant = s.restaurant; state.payments = s.payments || {};
      await loadAll(); connectSocket(); renderShell();
    } catch { renderLogin(); }
  }
  boot();
})();
