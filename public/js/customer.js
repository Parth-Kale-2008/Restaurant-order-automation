/* ===========================================================================
   ANAND PALACE — guest ordering app  ("Aurelia" premium UI, live backend)
   Menu, cart, live order tracking, GST payment + receipt — all wired to the
   server. The server owns prices & order ownership (signed `sid` cookie);
   this file only renders state and calls the API.
   =========================================================================== */
(() => {
  "use strict";

  // ---- DOM refs -----------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const tabsEl = $("category-tabs");
  const menuEl = $("menu-container");
  const cartBar = $("cart-bar");
  const sheet = $("sheet");
  const sheetContent = $("sheet-content");
  const toastEl = $("toast");

  // ---- state --------------------------------------------------------------
  const state = {
    menu: null,
    restaurant: null,
    table: null,
    guest: null,
    order: null,
    currentCat: null,
    sheetMode: null, // cart | track | pay | processing | receipt
    payMethod: "upi",
    lastStatus: null,
    fbRating: 0 // stars selected in the feedback card (not yet submitted)
  };

  // ---- helpers ------------------------------------------------------------
  const rupees = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");
  const rupees2 = (n) =>
    "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDateTime = (ts) =>
    new Date(ts).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || "Something went wrong");
      e.status = res.status;
      throw e;
    }
    return data;
  }

  /* Mirrors of the server's cleanName/cleanPhone. The server is the real gate -- these exist
     so a guest gets told what is wrong BEFORE the round trip, and so the button can stay
     disabled until the fields are usable. Kept deliberately identical, marks included:
     "\p{M}" is why Devanagari names like "राहुल" pass. */
  const NAME_RE = /^\p{L}[\p{L}\p{M}\s.'-]{1,39}$/u;
  const okName = (v) => NAME_RE.test(String(v || "").trim().replace(/\s+/g, " "));
  const digits10 = (v) => String(v || "").replace(/\D/g, "").replace(/^(?:0|91)(?=\d{10}$)/, "");
  const okPhone = (v) => /^[6-9]\d{9}$/.test(digits10(v));

  let toastTimer;
  function toast(msg, isError = false) {
    toastEl.textContent = msg;
    toastEl.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.className = "toast"), 2600);
  }

  // Big, celebratory "your food is ready" announcement (more than a toast).
  let readyTimer;
  function showReadyBanner() {
    let el = document.getElementById("ready-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "ready-banner";
      el.className = "ready-banner";
      el.innerHTML = `
        <button class="rb-close" aria-label="Dismiss">&times;</button>
        <div class="rb-bell">🔔</div>
        <div class="rb-text"><b>Your food is ready!</b><span>It’s freshly plated and on its way to your table.</span></div>`;
      document.body.appendChild(el);
      el.querySelector(".rb-close").onclick = () => el.classList.remove("show");
      el.onclick = (e) => { if (e.target === el) openSheet(); };
    }
    void el.offsetWidth;
    el.classList.add("show");
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => el.classList.remove("show"), 9000);
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  }

  const itemsOf = () => (state.order && state.order.items) || [];
  const qtyOf = (itemId) => (itemsOf().find((i) => i.itemId === itemId) || {}).qty || 0;
  const itemCount = () => itemsOf().reduce((n, i) => n + i.qty, 0);
  const orderStatus = () => (state.order ? state.order.status : null);
  const isEditable = () => {
    const s = orderStatus();
    return !s || s === "cart" || s === "placed";
  };

  function findItemDef(itemId) {
    for (const c of state.menu.categories) {
      const it = c.items.find((i) => i.id === itemId);
      if (it) return it;
    }
    return null;
  }

  // ========================================================================
  // TABS + MENU
  // ========================================================================
  // ---- colour mode ---------------------------------------------------------
  // The table decides the light: a candle-lit dinner wants the dark card, a bright lunch
  // window wants ivory. The choice is remembered per device; the pre-paint script in
  // table.html has already applied it, so this only wires the switch and the icon.
  function wireThemeToggle() {
    const btn = $("theme-toggle");
    if (!btn) return;
    const icon = () => {
      const dark = document.documentElement.getAttribute("data-theme") !== "light";
      btn.innerHTML = `<i class="fa-solid fa-${dark ? "moon" : "sun"}" aria-hidden="true"></i>`;
      btn.setAttribute("aria-label", dark ? "Switch to the daylight menu" : "Switch to the evening menu");
    };
    icon();
    btn.onclick = () => {
      const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("ap-theme", next); } catch (e) { /* private mode */ }
      icon();
    };
  }

  // A course with no dishes is a dead tab leading to an empty screen — never show one.
  const liveCategories = () => (state.menu.categories || []).filter((c) => (c.items || []).length);

  function renderTabs() {
    tabsEl.innerHTML = "";
    liveCategories().forEach((c) => {
      const btn = document.createElement("button");
      btn.className = "tab-btn" + (c.id === state.currentCat ? " active" : "");
      btn.innerHTML = `<span>${c.icon || ""}</span> ${esc(c.name)}`;
      btn.onclick = () => {
        state.currentCat = c.id;
        renderTabs();
        renderMenu();
        const active = tabsEl.querySelector(".active");
        if (active) active.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      };
      tabsEl.appendChild(btn);
    });
  }

  function badgeHtml(item) {
    const out = [];
    // Merchandising badges first — these push our most profitable / popular dishes.
    if (item.special) out.push(`<div class="badge special"><i class="fa-solid fa-crown"></i> Chef's Special</div>`);
    if (item.bestseller) out.push(`<div class="badge best"><i class="fa-solid fa-star"></i> Bestseller</div>`);
    if (item.veg) out.push(`<div class="badge veg"><i class="fa-solid fa-leaf"></i> Veg</div>`);
    else out.push(`<div class="badge nonveg"><i class="fa-solid fa-drumstick-bite"></i> Non-veg</div>`);
    (item.badges || []).forEach((b) => {
      if (b === "spicy") out.push(`<div class="badge spicy"><i class="fa-solid fa-fire"></i> Spicy</div>`);
      else if (b === "gf") out.push(`<div class="badge gf">GF</div>`);
    });
    return out.join("");
  }

  function renderMenu() {
    // EMPTY COURSE GUARD — a course with no dishes renders as a dead tab and an empty screen
    const cat = state.menu.categories.find((c) => c.id === state.currentCat);
    if (!cat) return;
    const editable = isEditable();

    menuEl.innerHTML = `
      <div class="cat-heading">
        <h2>${esc(cat.name)}</h2>
        <p>${esc(cat.tagline || "")}</p>
      </div>
      ${cat.items
        .map((item, i) => {
          const qty = qtyOf(item.id);
          const added = qty > 0;
          return `
        <div class="dish-card ${editable ? "" : "locked"}" style="animation-delay:${i * 0.08}s" data-card="${item.id}">
          <div class="dish-img-wrapper">
            <img class="dish-img" src="${esc(item.img || "")}" alt="${esc(item.name)}"
                 width="800" height="600" loading="lazy" decoding="async"
                 data-emoji="${esc(item.emoji || "🍽️")}" data-glow="${esc((cat.theme && cat.theme.glow) || "#2a2a2e")}">
            <div class="img-overlay"></div>
            <div class="dietary-badges">${badgeHtml(item)}</div>
          </div>
          <div class="dish-content">
            <div class="dish-header">
              <h3 class="dish-name">${esc(item.name)}</h3>
              <span class="dish-price">${rupees(item.price)}</span>
            </div>
            <p class="dish-desc">${esc(item.desc || "")}</p>
            <div class="card-action-area" data-action="${item.id}">
              <button class="btn-add ${added ? "hidden" : ""}"><i class="fa-solid fa-plus"></i> Add to Order</button>
              <div class="qty-control-inline ${added ? "active" : ""}">
                <button class="qty-btn" data-d="-1"><i class="fa-solid fa-minus"></i></button>
                <span class="qty-val">${qty}</span>
                <button class="qty-btn" data-d="1"><i class="fa-solid fa-plus"></i></button>
              </div>
            </div>
          </div>
        </div>`;
        })
        .join("")}
      <p class="photo-credit">Dish photography: Wikimedia Commons contributors ·
        <a href="/photo-credits.html" target="_blank" rel="noopener">licences &amp; credits</a></p>
    `;

    // fade each photo in once it has actually decoded (the shimmer covers the gap)
    menuEl.querySelectorAll(".dish-img").forEach((img) => {
      if (img.complete && img.naturalWidth) img.classList.add("is-loaded");
      else img.addEventListener("load", () => img.classList.add("is-loaded"), { once: true });
    });

    // image fallback → emoji medallion
    menuEl.querySelectorAll(".dish-img").forEach((img) => {
      img.addEventListener("error", () => {
        const fb = document.createElement("div");
        fb.className = "dish-img-fallback";
        fb.style.setProperty("--fb-glow", (img.dataset.glow || "#2a2a2e") + "44");
        fb.textContent = img.dataset.emoji || "🍽️";
        img.replaceWith(fb);
      });
    });

    // wire actions
    menuEl.querySelectorAll(".card-action-area").forEach((area) => {
      const itemId = area.dataset.action;
      const addBtn = area.querySelector(".btn-add");
      addBtn.onclick = () => changeItem(itemId, 1);
      area.querySelectorAll(".qty-btn").forEach((b) => {
        b.onclick = () => changeItem(itemId, qtyOf(itemId) + Number(b.dataset.d));
      });
    });
  }

  function syncCardUI(itemId) {
    const area = menuEl.querySelector(`.card-action-area[data-action="${itemId}"]`);
    if (!area) return;
    const qty = qtyOf(itemId);
    const addBtn = area.querySelector(".btn-add");
    const ctrl = area.querySelector(".qty-control-inline");
    const val = area.querySelector(".qty-val");
    if (qty > 0) {
      addBtn.classList.add("hidden");
      ctrl.classList.add("active");
      val.textContent = qty;
    } else {
      addBtn.classList.remove("hidden");
      ctrl.classList.remove("active");
    }
  }

  // ========================================================================
  // CART ACTIONS
  // ========================================================================
  async function changeItem(itemId, newQty) {
    if (!isEditable()) {
      toast("Your order is already in the kitchen — please call our staff.", true);
      return;
    }
    // Don't let a guest empty an already-placed order — that's a staff-side cancel.
    if (newQty <= 0 && orderStatus() === "placed" && itemsOf().length === 1 && qtyOf(itemId) > 0) {
      toast("To cancel the whole order, please call our staff.", true);
      return;
    }
    try {
      const { order } = await api("/api/order/item", {
        method: "POST",
        body: { itemId, qty: Math.max(0, newQty) }
      });
      state.order = order;
      syncCardUI(itemId);
      updateCartBar(true);
      if (sheet.classList.contains("active") && state.sheetMode === "cart") drawSheet();
    } catch (e) {
      handleError(e);
    }
  }

  function updateCartBar(pulse) {
    const status = orderStatus();
    const count = itemCount();
    const placed = status && status !== "cart";
    const paid = status === "paid";

    cartBar.classList.toggle("is-status", placed && !paid);
    cartBar.classList.toggle("is-paid", paid);

    if (count === 0 && !placed) {
      cartBar.classList.remove("visible");
      return;
    }
    cartBar.classList.add("visible");
    if (pulse) {
      cartBar.classList.remove("pulse");
      void cartBar.offsetWidth;
      cartBar.classList.add("pulse");
    }

    const icon = $("cart-icon");
    $("cart-count").textContent = paid ? "✓" : count;
    $("cart-total").textContent = rupees(state.order ? state.order.total : 0);
    if (paid) {
      $("cart-cta").textContent = "View Bill";
      icon.className = "fa-solid fa-receipt";
    } else if (placed) {
      $("cart-cta").textContent = status === "placed" ? "Edit / Track" : "Track Order";
      icon.className = "fa-solid fa-utensils";
    } else {
      $("cart-cta").textContent = "Review";
      icon.className = "fa-solid fa-bell-concierge";
    }
  }

  // ========================================================================
  // SHEET (cart / tracker / payment / receipt)
  // ========================================================================
  function openSheet() {
    const s = orderStatus();
    if (s === "paid") state.sheetMode = "receipt";
    else if (s && s !== "cart") state.sheetMode = "track";
    else state.sheetMode = "cart";
    drawSheet();
    sheet.classList.add("active");
    document.body.style.overflow = "hidden";
  }
  function closeSheet() {
    sheet.classList.remove("active");
    document.body.style.overflow = "";
  }

  function drawSheet() {
    const m = state.sheetMode;
    if (m === "cart") sheetContent.innerHTML = cartView();
    else if (m === "track") sheetContent.innerHTML = trackerView();
    else if (m === "pay") sheetContent.innerHTML = payView();
    else if (m === "processing") sheetContent.innerHTML = processingView();
    else if (m === "receipt") sheetContent.innerHTML = receiptView();
    wireSheet();
  }

  // ---- cart view ----
  function cartView() {
    const items = itemsOf();
    if (!items.length) {
      return `
        <div class="sheet-grip"></div>
        <div class="modal-header"><h2 class="modal-title serif">Your Selection</h2>
          <button class="close-btn" data-close><i class="fa-solid fa-xmark"></i></button></div>
        <div class="empty-sheet"><i class="fa-solid fa-utensils"></i><h3>Your plate is empty</h3>
          <p>Add a few dishes to begin your feast.</p></div>`;
    }
    const cust = (state.order && state.order.customer) || {};
    return `
      <div class="sheet-grip"></div>
      <div class="modal-header">
        <div><h2 class="modal-title serif">Your Selection</h2>
          <div class="modal-sub">${esc(state.table.name)} · Guest #${esc(state.guest)}</div></div>
        <button class="close-btn" data-close><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="sheet-scroll">
        ${items
          .map(
            (i) => `
          <div class="cart-item-row" data-row="${i.itemId}">
            <div class="cart-item-info">
              <div class="cart-item-name"><span class="em">${i.emoji || ""}</span>${esc(i.name)}</div>
              <div class="cart-item-price">${rupees(i.price * i.qty)} <span style="color:var(--text-muted);font-family:Manrope">· ${rupees(i.price)} ea</span></div>
            </div>
            <div class="modal-qty-ctrl">
              <button class="modal-qty-btn" data-d="-1"><i class="fa-solid fa-minus"></i></button>
              <span class="modal-qty-val">${i.qty}</span>
              <button class="modal-qty-btn" data-d="1"><i class="fa-solid fa-plus"></i></button>
            </div>
          </div>`
          )
          .join("")}
      </div>
      <div class="bill-box">
        <div class="bill-line"><span>Item total</span><b>${rupees(state.order.total)}</b></div>
        <div class="bill-line"><span>GST (5%)</span><span>calculated at payment</span></div>
      </div>
      <div class="guest-id">
        <div class="gi-title">Who's ordering?</div>
        <label class="gi-field">
          <span>Your name</span>
          <input id="gi-name" type="text" autocomplete="name" maxlength="40"
                 placeholder="e.g. Ravi Kumar" value="${esc(cust.name || "")}">
        </label>
        <label class="gi-field">
          <span>Mobile number</span>
          <input id="gi-phone" type="tel" inputmode="numeric" autocomplete="tel" maxlength="15"
                 placeholder="10-digit mobile" value="${esc(cust.phone || "")}">
        </label>
        <div class="gi-err" id="gi-err"></div>
        <div class="gi-note">So the kitchen knows whose order this is, and we can reach you if there's a question.</div>
      </div>
      <div class="modal-footer">
        <button class="btn-checkout spread" data-place><span>Place Order</span><span>${rupees(state.order.total)}</span></button>
      </div>`;
  }

  // ---- tracker view ----
  const STEPS = [
    { key: "placed", label: "Order Placed", sub: "We’ve received your order", icon: "📝" },
    { key: "preparing", label: "Preparing", sub: "Our chefs are on it", icon: "👨‍🍳" },
    { key: "ready", label: "Ready", sub: "Freshly plated", icon: "🔔" },
    { key: "served", label: "Served", sub: "Enjoy your meal!", icon: "🍽️" }
  ];
  function trackerView() {
    const o = state.order;
    const idx = Math.max(0, STEPS.findIndex((s) => s.key === o.status));
    const cur = STEPS[idx] || STEPS[0];
    const editable = o.status === "placed"; // guest may still change it until the kitchen starts
    const steps = STEPS.map((s, i) => {
      const cls = i < idx ? "done" : i === idx ? "current" : "";
      return `
        <div class="step ${cls}">
          <div class="dot-wrap"><div class="dot">${cls === "done" ? "✓" : s.icon}</div><div class="bar"></div></div>
          <div class="step-label"><b>${s.label}</b><small>${s.sub}</small></div>
        </div>`;
    }).join("");

    // While the order is only "placed", let the guest tweak quantities or add more
    // dishes — these changes save instantly and show up live on the reception board.
    const editBlock = editable ? `
        <div class="edit-banner">
          <i class="fa-solid fa-pen-to-square"></i>
          <span>You can still change this order until the kitchen starts preparing.</span>
        </div>
        <div class="edit-items">
          ${itemsOf()
            .map(
              (i) => `
            <div class="cart-item-row" data-row="${i.itemId}">
              <div class="cart-item-info">
                <div class="cart-item-name"><span class="em">${i.emoji || ""}</span>${esc(i.name)}</div>
                <div class="cart-item-price">${rupees(i.price * i.qty)} <span style="color:var(--text-muted);font-family:Manrope">· ${rupees(i.price)} ea</span></div>
              </div>
              <div class="modal-qty-ctrl">
                <button class="modal-qty-btn" data-d="-1"><i class="fa-solid fa-minus"></i></button>
                <span class="modal-qty-val">${i.qty}</span>
                <button class="modal-qty-btn" data-d="1"><i class="fa-solid fa-plus"></i></button>
              </div>
            </div>`
            )
            .join("") || `<p class="edit-empty">Your order is empty — add a dish to keep it going.</p>`}
        </div>
        <button class="btn-ghost" data-addmore><i class="fa-solid fa-plus"></i> Add more dishes</button>` : "";

    return `
      <div class="sheet-grip"></div>
      <div class="modal-header"><div></div><button class="close-btn" data-close><i class="fa-solid fa-xmark"></i></button></div>
      <div class="sheet-scroll">
        <div class="tracker-head">
          <div class="big">${cur.icon}</div>
          <h3>${cur.label}</h3>
          <p>${esc(state.table.name)} · ${itemCount()} items · ${rupees(o.total)}</p>
        </div>
        ${editBlock}
        <div class="steps">${steps}</div>
      </div>
      <div class="modal-footer">
        <button class="btn-checkout" data-pay><i class="fa-solid fa-credit-card"></i> Pay & Get Bill</button>
        <button class="btn-ghost" data-close>Back to menu</button>
      </div>`;
  }

  // ---- payment view ----
  const METHODS = [
    { id: "upi", emoji: "📲", name: "UPI", sub: "Google Pay · PhonePe · Paytm" },
    { id: "card", emoji: "💳", name: "Card", sub: "Credit / Debit card" },
    { id: "cash", emoji: "💵", name: "Cash", sub: "Pay at the counter" }
  ];
  function payView() {
    const sub = state.order.total;
    const cgst = +(sub * 0.025).toFixed(2);
    const sgst = +(sub * 0.025).toFixed(2);
    const total = +(sub + cgst + sgst).toFixed(2);
    return `
      <div class="sheet-grip"></div>
      <div class="modal-header">
        <div><h2 class="modal-title serif">Checkout</h2><div class="modal-sub">Invoice generated instantly</div></div>
        <button class="close-btn" data-back><i class="fa-solid fa-arrow-left"></i></button>
      </div>
      <div class="sheet-scroll">
        <div class="bill-box">
          <div class="bill-line"><span>Item total</span><span>${rupees2(sub)}</span></div>
          <div class="bill-line"><span>CGST (2.5%)</span><span>${rupees2(cgst)}</span></div>
          <div class="bill-line"><span>SGST (2.5%)</span><span>${rupees2(sgst)}</span></div>
          <div class="bill-grand"><span>To pay</span><span>${rupees2(total)}</span></div>
        </div>
        <div class="pay-methods">
          ${METHODS.map(
            (m) => `
            <div class="pay-method ${state.payMethod === m.id ? "sel" : ""}" data-method="${m.id}">
              <span class="pe">${m.emoji}</span>
              <div class="pl"><b>${m.name}</b><small>${m.sub}</small></div>
              <span class="radio"></span>
            </div>`
          ).join("")}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-checkout spread" data-paynow><span>Pay Now</span><span>${rupees2(total)}</span></button>
      </div>`;
  }

  function processingView() {
    return `
      <div class="sheet-grip"></div>
      <div class="pay-processing">
        <div class="coin">🪙</div>
        <h3>Processing payment…</h3>
        <p>Securing your transaction</p>
      </div>`;
  }

  // ---- receipt view ----
  function receiptView() {
    const o = state.order;
    const b = o.bill || {};
    const r = state.restaurant;
    const methodLabel = { upi: "UPI", card: "Card", cash: "Cash" }[b.method] || "—";
    return `
      <div class="sheet-grip"></div>
      <div class="modal-header"><div></div><button class="close-btn" data-close><i class="fa-solid fa-xmark"></i></button></div>
      <div class="sheet-scroll">
        <div class="receipt-success">
          <div class="check">✓</div>
          <h3>Payment Successful</h3>
          <p>Your bill is ready — thank you for dining with us!</p>
        </div>
        <div class="receipt" id="receipt">
          <div class="r-paid">PAID</div>
          <div class="r-head">
            <div class="r-emblem">🏰</div>
            <div class="r-name">${esc(r.name)}</div>
            <div class="r-meta">${esc(r.tagline)}<br>${esc(r.address)}<br>☎ ${esc(r.phone)}<br>GSTIN: ${esc(r.gstin)} · FSSAI: ${esc(r.fssai)}</div>
          </div>
          <div class="r-info">
            <div>Invoice: <b>${esc(b.invoiceNo || "—")}</b></div>
            <div>${esc(state.table.name)}</div>
            <div>${esc(fmtDateTime(b.paidAt || Date.now()))}</div>
            <div>Guest #${esc(state.guest)}</div>
          </div>
          <div class="r-items">
            ${o.items
              .map(
                (i) => `<div class="r-item"><span class="ri-q">${i.qty}×</span><span class="ri-n">${esc(i.name)}</span><span class="ri-p">${rupees2(i.price * i.qty)}</span></div>`
              )
              .join("")}
          </div>
          <div class="r-tot">
            <div class="l"><span>Subtotal</span><span>${rupees2(b.subtotal)}</span></div>
            <div class="l"><span>CGST (2.5%)</span><span>${rupees2(b.cgst)}</span></div>
            <div class="l"><span>SGST (2.5%)</span><span>${rupees2(b.sgst)}</span></div>
            <div class="grand"><span>Grand Total</span><span>${rupees2(b.total)}</span></div>
            <div class="l" style="margin-top:6px"><span>Paid via</span><span>${esc(methodLabel)}</span></div>
          </div>
          <div class="r-foot"><div class="ty">Thank you! Please visit again 🙏</div>Powered by Anand Palace · table-side ordering</div>
        </div>
        ${feedbackCard(o)}
        ${
          r.reviewUrl
            ? `<div class="review-card">
                <div class="stars">★★★★★</div>
                <h4>Loved your meal?</h4>
                <p>A quick Google review helps our little kitchen so much.</p>
                <a class="btn-checkout" href="${esc(r.reviewUrl)}" target="_blank" rel="noopener">
                  <i class="fa-brands fa-google"></i> Rate us on Google
                </a>
              </div>`
            : ""
        }
      </div>
      <div class="receipt-actions">
        <button class="btn-ghost" data-print><i class="fa-solid fa-print"></i> Download / Print</button>
        <button class="btn-checkout" data-again>Order Again</button>
      </div>`;
  }

  // ---- feedback card (rendered inside the receipt) ----
  function feedbackCard(o) {
    if (o.feedback) {
      const fr = o.feedback.rating;
      return `
        <div class="review-card fb-done">
          <div class="stars">${"★".repeat(fr)}${"☆".repeat(5 - fr)}</div>
          <h4>Thanks for your feedback!</h4>
          <p>${o.feedback.comment ? esc(o.feedback.comment) : "We’re so glad you dined with us."}</p>
        </div>`;
    }
    return `
      <div class="review-card fb-card">
        <h4>How was your meal?</h4>
        <p>Your feedback goes straight to our kitchen.</p>
        <div class="fb-stars" id="fb-stars">
          ${[1, 2, 3, 4, 5].map((n) => `<button class="fb-star" data-star="${n}" aria-label="${n} star">★</button>`).join("")}
        </div>
        <textarea class="fb-text" id="fb-comment" rows="3" maxlength="500" placeholder="Tell us what you loved (optional)"></textarea>
        <button class="btn-checkout" data-feedback><i class="fa-solid fa-paper-plane"></i> Send Feedback</button>
      </div>`;
  }

  async function submitFeedback() {
    if (!state.fbRating) { toast("Please tap a star to rate first.", true); return; }
    const ta = sheetContent.querySelector("#fb-comment");
    const comment = ta ? ta.value : "";
    const btn = sheetContent.querySelector("[data-feedback]");
    if (btn) btn.disabled = true;
    try {
      const { order } = await api("/api/order/feedback", { method: "POST", body: { rating: state.fbRating, comment } });
      state.order = order;
      state.fbRating = 0;
      toast("🙏 Thank you for your feedback!");
      if (state.sheetMode === "receipt") drawSheet();
    } catch (e) {
      if (btn) btn.disabled = false;
      handleError(e);
    }
  }

  // ---- sheet wiring ----
  function wireSheet() {
    sheetContent.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeSheet));

    // cart / tracker row qty
    sheetContent.querySelectorAll(".cart-item-row").forEach((row) => {
      const itemId = row.dataset.row;
      row.querySelectorAll(".modal-qty-btn").forEach((b) => {
        b.onclick = async () => {
          await changeItem(itemId, qtyOf(itemId) + Number(b.dataset.d));
          if (state.sheetMode === "cart" || state.sheetMode === "track") drawSheet();
        };
      });
    });

    // "Add more dishes" (from the live tracker) — drop back to the menu to browse.
    const addmore = sheetContent.querySelector("[data-addmore]");
    if (addmore) addmore.onclick = closeSheet;

    const place = sheetContent.querySelector("[data-place]");
    if (place) place.onclick = placeOrder;

    const pay = sheetContent.querySelector("[data-pay]");
    if (pay) pay.onclick = () => { state.sheetMode = "pay"; drawSheet(); };

    const back = sheetContent.querySelector("[data-back]");
    if (back) back.onclick = () => { state.sheetMode = "track"; drawSheet(); };

    sheetContent.querySelectorAll(".pay-method").forEach((el) => {
      el.onclick = () => { state.payMethod = el.dataset.method; drawSheet(); };
    });

    const paynow = sheetContent.querySelector("[data-paynow]");
    if (paynow) paynow.onclick = doPay;

    const print = sheetContent.querySelector("[data-print]");
    if (print) print.onclick = () => window.print();

    const again = sheetContent.querySelector("[data-again]");
    if (again) again.onclick = orderAgain;

    // feedback: star picker + submit
    const fbStars = sheetContent.querySelectorAll(".fb-star");
    fbStars.forEach((b) => {
      b.onclick = () => {
        state.fbRating = Number(b.dataset.star);
        fbStars.forEach((s) => s.classList.toggle("on", Number(s.dataset.star) <= state.fbRating));
      };
    });
    const fb = sheetContent.querySelector("[data-feedback]");
    if (fb) fb.onclick = submitFeedback;
  }

  async function placeOrder() {
    const nameEl = $("gi-name"), phoneEl = $("gi-phone"), errEl = $("gi-err");
    const name = nameEl ? nameEl.value : "";
    const phone = phoneEl ? phoneEl.value : "";
    const showErr = (msg, el) => {
      if (errEl) errEl.textContent = msg;
      if (el) { el.classList.add("bad"); el.focus(); }
      // no toast: the inline message sits right under the field, and a toast on top of it
      // literally covered the text it was repeating
    };
    if (nameEl) nameEl.classList.remove("bad");
    if (phoneEl) phoneEl.classList.remove("bad");
    if (!okName(name)) return showErr("Please enter your name.", nameEl);
    if (!okPhone(phone)) return showErr("Enter a valid 10-digit mobile number.", phoneEl);
    if (errEl) errEl.textContent = "";
    try {
      const { order } = await api("/api/order/place", { method: "POST", body: { name, phone } });
      state.order = order;
      state.lastStatus = order.status;
      toast("🛎️ Order sent to the kitchen!");
      state.sheetMode = "track";
      drawSheet();
      updateCartBar();
      renderMenu(); // lock cards
    } catch (e) {
      handleError(e);
    }
  }

  async function doPay() {
    state.sheetMode = "processing";
    drawSheet();
    try {
      const resp = await api("/api/order/pay", { method: "POST", body: { method: state.payMethod } });
      // Razorpay path: server returned a checkout intent (order not yet paid).
      if (resp.needsPayment && resp.rzp && window.Razorpay) {
        return openRazorpay(resp.rzp);
      }
      // Recorded-payment path (no gateway / cash): brief delay so it reads as real.
      await new Promise((r) => setTimeout(r, 900));
      finishPaid(resp.order);
    } catch (e) {
      state.sheetMode = "track";
      drawSheet();
      handleError(e);
    }
  }

  function openRazorpay(rzp) {
    const rz = new window.Razorpay({
      key: rzp.key,
      order_id: rzp.orderId,
      amount: rzp.amount,
      currency: rzp.currency,
      name: rzp.name,
      description: rzp.description,
      theme: { color: "#d4af37" },
      handler: async (resp) => {
        state.sheetMode = "processing";
        drawSheet();
        try {
          const { order } = await api("/api/order/pay/verify", {
            method: "POST",
            body: {
              method: rzp.method,
              razorpay_order_id: resp.razorpay_order_id,
              razorpay_payment_id: resp.razorpay_payment_id,
              razorpay_signature: resp.razorpay_signature
            }
          });
          finishPaid(order);
        } catch (e) { state.sheetMode = "track"; drawSheet(); handleError(e); }
      },
      modal: { ondismiss: () => { state.sheetMode = "pay"; drawSheet(); toast("Payment cancelled.", true); } }
    });
    rz.on("payment.failed", () => { state.sheetMode = "pay"; drawSheet(); toast("Payment failed — please try again.", true); });
    rz.open();
  }

  function finishPaid(order) {
    state.order = order;
    state.lastStatus = order.status;
    state.sheetMode = "receipt";
    drawSheet();
    updateCartBar();
  }

  function orderAgain() {
    closeSheet();
    state.order = null;
    state.lastStatus = null;
    state.fbRating = 0;
    cartBar.classList.remove("visible", "is-status", "is-paid");
    renderMenu();
    toast("Start a fresh order whenever you’re ready 🙏");
  }

  // ========================================================================
  // ERRORS + LIVE
  // ========================================================================
  function handleError(e) {
    if (e.status === 401) return showScanAgain();
    toast(e.message, true);
  }
  function showScanAgain() {
    closeSheet();
    cartBar.classList.remove("visible");
    menuEl.innerHTML = `
      <div class="center-card">
        <span class="e">📷</span>
        <h2 class="serif">Scan your table QR</h2>
        <p>Your session has expired. Please scan the QR code on your table again to keep ordering.</p>
      </div>`;
    tabsEl.innerHTML = "";
  }

  function connectSocket() {
    const socket = io();
    socket.on("order:changed", (order) => {
      if (!order) return;
      const prev = state.lastStatus;
      state.order = order;
      state.lastStatus = order.status;
      updateCartBar();

      // status toasts (kitchen-driven transitions)
      if (prev !== order.status) {
        if (order.status === "preparing") toast("👨‍🍳 The kitchen started your order!");
        else if (order.status === "ready") showReadyBanner(); // big, can't-miss announcement
        else if (order.status === "served") toast("🍽️ Served — enjoy your meal!");
        else if (order.status === "cancelled") toast("Your order was cancelled. Please call our staff.", true);
      }

      // refresh card lock state if menu is showing
      if (!isEditable()) renderMenu();

      // keep the open sheet in sync, but never yank the user out of payment screens
      if (sheet.classList.contains("active") && !["pay", "processing", "receipt"].includes(state.sheetMode)) {
        state.sheetMode = order.status === "paid" ? "receipt" : order.status !== "cart" ? "track" : "cart";
        drawSheet();
      }
    });
  }

  // ========================================================================
  // BOOT
  // ========================================================================
  cartBar.addEventListener("click", openSheet);
  sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });

  async function boot() {
    try {
      const [me, menu] = await Promise.all([api("/api/me"), api("/api/menu")]);
      state.menu = menu;
      state.restaurant = me.restaurant;
      state.table = me.table;
      state.guest = me.guest;
      state.order = me.order;
      state.lastStatus = me.order ? me.order.status : null;
      state.currentCat = (menu.categories || []).find((c) => (c.items || []).length)?.id;

      $("brand-name").textContent = me.restaurant.name;
      $("brand-tag").textContent = me.restaurant.tagline;
      $("table-display").textContent = me.table.name;

      renderTabs();
      renderMenu();
      updateCartBar();
      wireThemeToggle();
      connectSocket();
    } catch (e) {
      if (e.status === 401) return showScanAgain();
      menuEl.innerHTML = `<div class="center-card"><span class="e">⚠️</span><h2 class="serif">Something went wrong</h2><p>${esc(e.message)}</p></div>`;
    }
  }

  boot();
})();
