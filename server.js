/**
 * Anand Palace — multi-tenant QR table-ordering platform.
 *
 *  • Many restaurants live in one deployment. Each has its own menu, tables,
 *    settings, manager password and invoice series. Data is isolated by a
 *    restaurant "slug" carried in the guest's signed `table` cookie and the
 *    manager's JWT — handlers never reach across tenants.
 *  • Guests scan a per-table QR (with a secret token) -> /r/:slug/table/:id ->
 *    build & place an order, pay (Razorpay if configured, else recorded), and
 *    watch live status. Each browser's order is private to its signed `sid`.
 *  • Managers sign in per restaurant and watch/advance every table live, edit
 *    their menu, see analytics and print kitchen tickets.
 *  • A super-admin (/admin) creates new restaurants.
 *
 *  Legacy single-restaurant routes (/table/:id, /manager) still work and map to
 *  the first/default restaurant.
 */

const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const express = require("express");
const cookieParser = require("cookie-parser");
const cookieLib = require("cookie");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const QRCode = require("qrcode");
const { Server } = require("socket.io");

const store = require("./lib/store");
const mongo = require("./lib/mongo");

// ---------------------------------------------------------------------------
// Config / secrets
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "superadmin";
// Signing keys persist across restarts (via lib/store) unless overridden by env,
// so a deploy no longer logs out every signed-in manager.
const COOKIE_SECRET = store.getSecret("cookie", process.env.COOKIE_SECRET);
const JWT_SECRET = store.getSecret("jwt", process.env.JWT_SECRET);

// Razorpay (optional). When both are set, real online payments are used;
// otherwise payment is recorded directly (great for demos / cash-only setups).
const RZP_KEY = process.env.RAZORPAY_KEY_ID || "";
const RZP_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const razorpayEnabled = () => !!(RZP_KEY && RZP_SECRET);

const STATUS_FLOW = ["placed", "preparing", "ready", "served", "paid"];
const EDITABLE_STATUSES = ["cart", "placed"];
const CGST = 0.025;
const SGST = 0.025;

store.load();

// Mirror the JSON store into MongoDB ("anand-palace" DB) for browsing/reporting.
// Non-fatal: if Mongo is unavailable the app still runs on the JSON store.
// (Logged from the callback so the status is accurate once the async connect settles.)
mongo.connect()
  .then((info) => {
    mongo.sync(store.getDb());                  // initial full sync
    store.onPersist((snap) => mongo.sync(snap)); // keep in sync on every change
    console.log(`  MongoDB       : synced -> ${info.db} (${info.uri})`);
  })
  .catch((e) => { console.warn(`  MongoDB       : unavailable (${e.message}) — running on JSON store only`); });

const app = express();
// Behind a hosting proxy (Render/Koyeb/Fly terminate TLS for us) req.protocol reports "http"
// unless we trust the X-Forwarded-* headers -- which would bake http:// into every printed QR
// code and into the manager URLs handed out by /admin. Harmless locally.
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(cookieParser(COOKIE_SECRET));
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const db = () => store.getDb();
const restaurantOf = (slug) => store.getRestaurant(slug);

function publicRestaurant(r) {
  return {
    slug: r.slug, name: r.name, tagline: r.tagline, address: r.address,
    phone: r.phone, gstin: r.gstin, fssai: r.fssai, reviewUrl: r.reviewUrl
  };
}

function itemIndex(r) {
  const idx = {};
  for (const c of r.menu) for (const it of c.items || []) idx[it.id] = { ...it, categoryName: c.name };
  return idx;
}

function tableById(r, id) {
  return r.tables.find((t) => String(t.id) === String(id));
}

function orderTotal(order) {
  return order.items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

function currentOrder(slug, tableId, sid) {
  return Object.values(db().orders)
    .filter(
      (o) =>
        o.tenant === slug &&
        String(o.tableId) === String(tableId) &&
        o.sid === sid &&
        o.status !== "cancelled"
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

function getOrCreateOrder(slug, tableId, sid) {
  let order = currentOrder(slug, tableId, sid);
  if (!order || order.status === "paid") {
    const id = uuid();
    order = {
      id, tenant: slug, tableId: Number(tableId), sid,
      items: [], status: "cart",
      createdAt: Date.now(), updatedAt: Date.now(), placedAt: null
    };
    db().orders[id] = order;
  }
  return order;
}

function invoicePrefix(slug) {
  const p = slug.split("-").map((s) => s[0]).join("").toUpperCase().slice(0, 3);
  return p || "INV";
}

function settleBill(r, order, method) {
  if (order.bill) return order.bill;
  const subtotal = orderTotal(order);
  const cgst = Math.round(subtotal * CGST * 100) / 100;
  const sgst = Math.round(subtotal * SGST * 100) / 100;
  const total = Math.round((subtotal + cgst + sgst) * 100) / 100;
  r.invoiceSeq = (r.invoiceSeq || 0) + 1;
  order.bill = {
    invoiceNo: invoicePrefix(r.slug) + String(r.invoiceSeq).padStart(5, "0"),
    subtotal, cgst, sgst, total, gstPercent: 5,
    method: method || "cash", paidAt: Date.now()
  };
  order.paidAt = order.bill.paidAt;
  return order.bill;
}

function customerView(r, order) {
  if (!order) return null;
  const t = tableById(r, order.tableId);
  return {
    id: order.id, tableId: order.tableId,
    tableName: (t && t.name) || `Table ${order.tableId}`,
    guest: order.sid.slice(0, 6).toUpperCase(),
    items: order.items, status: order.status, total: orderTotal(order),
    placedAt: order.placedAt, paidAt: order.paidAt || null,
    bill: order.bill || null, feedback: order.feedback || null, updatedAt: order.updatedAt
  };
}

function managerView(order) {
  const r = restaurantOf(order.tenant);
  const t = r && tableById(r, order.tableId);
  return {
    id: order.id, tableId: order.tableId,
    tableName: (t && t.name) || `Table ${order.tableId}`,
    guest: order.sid.slice(0, 6).toUpperCase(),
    items: order.items, status: order.status, total: orderTotal(order),
    itemCount: order.items.reduce((n, i) => n + i.qty, 0),
    createdAt: order.createdAt, placedAt: order.placedAt,
    paidAt: order.paidAt || null, bill: order.bill || null,
    feedback: order.feedback || null, updatedAt: order.updatedAt,
    edited: !!order.edited, editedAt: order.editedAt || null,
    cleared: !!order.cleared, clearedAt: order.clearedAt || null
  };
}

function broadcastOrder(order) {
  const r = restaurantOf(order.tenant);
  io.to(`managers:${order.tenant}`).emit("order:changed", managerView(order));
  io.to(`sid:${order.sid}`).emit("order:changed", customerView(r, order));
}

const baseUrl = (req) => `${req.protocol}://${req.get("host")}`;

// The address QR codes must point at so PHONES can reach this server.
// `localhost` only works on the server itself, so if the dashboard is opened via
// localhost/127.0.0.1 we automatically swap in the machine's Wi-Fi (LAN) IP.
// Set PUBLIC_URL (e.g. https://order.yoursite.com) to override for cloud hosting.
function qrHost(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, "");
  const host = req.get("host") || "";
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
    const ip = lanAddresses()[0];
    if (ip) return `${req.protocol}://${ip}:${host.split(":")[1] || PORT}`;
  }
  return `${req.protocol}://${host}`;
}
const tableUrl = (req, slug, t) => `${qrHost(req)}/r/${slug}/table/${t.id}?t=${t.token}`;

function scanPromptPage(name) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>Scan your table QR</title>
    <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600&family=Manrope:wght@400;600&display=swap" rel="stylesheet">
    <style>body{margin:0;min-height:100vh;display:grid;place-items:center;text-align:center;font-family:Manrope,sans-serif;color:#f5f5f0;padding:28px;background:radial-gradient(700px 460px at 50% -10%,rgba(212,175,55,.10),transparent 60%),#0a0a0b}.e{font-size:64px}h1{font-family:Cinzel,serif;color:#d4af37;letter-spacing:2px;margin:14px 0 8px}p{color:#9ca3af;max-width:360px;line-height:1.6;margin:0 auto}</style></head>
    <body><div><div class="e">📷</div><h1>Please scan your table QR</h1>
    <p>To order from ${name || "your table"}, scan the QR code printed on it. Typing the web address by hand won't seat you — this keeps every table's orders correct and secure.</p></div></body></html>`;
}

// ---------------------------------------------------------------------------
// Razorpay (via REST — no SDK dependency)
// ---------------------------------------------------------------------------
function rzpCreateOrder(amountPaise, receipt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ amount: amountPaise, currency: "INR", receipt, payment_capture: 1 });
    const auth = Buffer.from(`${RZP_KEY}:${RZP_SECRET}`).toString("base64");
    const req = https.request(
      {
        hostname: "api.razorpay.com", path: "/v1/orders", method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
            else reject(new Error(json.error?.description || "Razorpay order failed"));
          } catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
function rzpVerify(orderId, paymentId, signature) {
  const expected = crypto.createHmac("sha256", RZP_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature || "")));
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function ensureSid(req, res) {
  let sid = req.signedCookies.sid;
  if (!sid) {
    sid = uuid();
    res.cookie("sid", sid, { httpOnly: true, signed: true, sameSite: "lax", maxAge: 30 * 864e5 });
  }
  return sid;
}

function requireCustomer(req, res, next) {
  const sid = req.signedCookies.sid;
  const tableCk = req.signedCookies.table; // "slug::id"
  if (!sid || !tableCk) return res.status(401).json({ error: "Please scan your table QR code again." });
  const [slug, tableId] = String(tableCk).split("::");
  const r = restaurantOf(slug);
  if (!r || !tableById(r, tableId)) return res.status(401).json({ error: "Please scan your table QR code again." });
  req.sid = sid; req.slug = slug; req.restaurant = r; req.tableId = tableId;
  next();
}

function requireManager(req, res, next) {
  const token = req.cookies.mgr;
  if (!token) return res.status(401).json({ error: "Not signed in." });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const r = restaurantOf(payload.tenant);
    if (!r) return res.status(401).json({ error: "Restaurant not found." });
    req.slug = payload.tenant; req.restaurant = r;
    next();
  } catch {
    return res.status(401).json({ error: "Session expired, sign in again." });
  }
}

function requireAdmin(req, res, next) {
  const token = req.cookies.adm;
  if (!token) return res.status(401).json({ error: "Not signed in." });
  try { jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: "Session expired." }); }
}

// In-memory brute-force throttle for the login endpoints.
const loginHits = new Map(); // key -> { count, first }
function tooManyAttempts(key, max = 8, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const rec = loginHits.get(key);
  if (!rec || now - rec.first > windowMs) { loginHits.set(key, { count: 1, first: now }); return false; }
  rec.count++;
  return rec.count > max;
}
const clearAttempts = (key) => loginHits.delete(key);

// ===========================================================================
// PAGE ROUTES
// ===========================================================================
function serveTable(req, res, slug) {
  const r = restaurantOf(slug);
  if (!r) return res.status(404).send("Unknown restaurant.");
  const table = tableById(r, req.params.id);
  if (!table) return res.status(404).send("Unknown table. Please ask our staff for help.");

  const token = req.query.t;
  const cookieVal = `${slug}::${table.id}`;
  const alreadySeated = req.signedCookies.table === cookieVal;
  if (table.token && token !== table.token && !alreadySeated) {
    return res.status(403).send(scanPromptPage(r.name));
  }
  ensureSid(req, res);
  res.cookie("table", cookieVal, { httpOnly: true, signed: true, sameSite: "lax", maxAge: 864e5 });
  res.sendFile(path.join(__dirname, "public", "table.html"));
}

app.get("/r/:slug/table/:id", (req, res) => serveTable(req, res, req.params.slug));
app.get("/table/:id", (req, res) => serveTable(req, res, store.defaultSlug())); // legacy

app.get("/r/:slug/manager", (req, res) => res.sendFile(path.join(__dirname, "public", "manager.html")));
app.get("/manager", (req, res) => res.sendFile(path.join(__dirname, "public", "manager.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// Local preview convenience: seat at the first table of the default restaurant.
app.get("/demo", (req, res) => {
  const r = restaurantOf(store.defaultSlug());
  const t = r && r.tables[0];
  if (!t) return res.redirect("/");
  res.redirect(tableUrl(req, r.slug, t));
});

// ===========================================================================
// PUBLIC API
// ===========================================================================
app.get("/api/menu", (req, res) => {
  // Tenant from the (validly signed) table cookie, else the default restaurant.
  let slug = store.defaultSlug();
  const tableCk = req.signedCookies.table;
  if (tableCk && restaurantOf(String(tableCk).split("::")[0])) slug = String(tableCk).split("::")[0];
  const r = restaurantOf(slug);
  res.json({ restaurant: publicRestaurant(r), categories: r.menu, payments: { razorpay: razorpayEnabled() } });
});

// ===========================================================================
// CUSTOMER API
// ===========================================================================
app.get("/api/me", requireCustomer, (req, res) => {
  const r = req.restaurant;
  const table = tableById(r, req.tableId);
  res.json({
    guest: req.sid.slice(0, 6).toUpperCase(),
    table: { id: table.id, name: table.name },
    restaurant: publicRestaurant(r),
    payments: { razorpay: razorpayEnabled() },
    order: customerView(r, currentOrder(req.slug, req.tableId, req.sid))
  });
});

app.get("/api/order", requireCustomer, (req, res) => {
  res.json({ order: customerView(req.restaurant, currentOrder(req.slug, req.tableId, req.sid)) });
});

app.post("/api/order/item", requireCustomer, (req, res) => {
  const { itemId, qty } = req.body || {};
  const def = itemIndex(req.restaurant)[itemId];
  if (!def) return res.status(400).json({ error: "Unknown menu item." });
  const quantity = Math.max(0, Math.min(50, parseInt(qty, 10) || 0));

  const order = getOrCreateOrder(req.slug, req.tableId, req.sid);
  if (!EDITABLE_STATUSES.includes(order.status)) {
    return res.status(409).json({ error: "Your order is already in the kitchen. Please call our staff to change it." });
  }
  const existing = order.items.find((i) => i.itemId === itemId);
  // A placed order may never be emptied by the guest — that's effectively a
  // cancellation, which is staff-controlled. Removing the last item is blocked.
  if (quantity === 0 && order.status === "placed" && existing && order.items.length === 1) {
    return res.status(409).json({ error: "To cancel the whole order, please call our staff." });
  }
  if (quantity === 0) order.items = order.items.filter((i) => i.itemId !== itemId);
  else if (existing) existing.qty = quantity;
  else order.items.push({ itemId: def.id, name: def.name, price: def.price, emoji: def.emoji, veg: def.veg, qty: quantity });

  // Flag genuine post-placement edits so the dashboard can show a real "edited"
  // marker (not a timestamp-difference guess).
  if (order.status === "placed") { order.edited = true; order.editedAt = Date.now(); }
  order.updatedAt = Date.now();
  store.save();
  broadcastOrder(order);
  res.json({ order: customerView(req.restaurant, order) });
});

app.post("/api/order/place", requireCustomer, (req, res) => {
  const order = currentOrder(req.slug, req.tableId, req.sid);
  if (!order || order.items.length === 0) return res.status(400).json({ error: "Add at least one dish before placing your order." });
  if (order.status === "cart") { order.status = "placed"; order.placedAt = Date.now(); }
  order.updatedAt = Date.now();
  store.save();
  broadcastOrder(order);
  res.json({ order: customerView(req.restaurant, order) });
});

// Pay. If Razorpay is configured and method != cash, return a checkout intent
// (does NOT mark paid). Otherwise record the payment immediately.
app.post("/api/order/pay", requireCustomer, async (req, res) => {
  const order = currentOrder(req.slug, req.tableId, req.sid);
  if (!order || order.items.length === 0) return res.status(400).json({ error: "There's no order to pay for yet." });
  if (order.status === "paid") return res.json({ order: customerView(req.restaurant, order) });

  const method = ["upi", "card", "cash"].includes(req.body?.method) ? req.body.method : "upi";

  if (razorpayEnabled() && method !== "cash") {
    try {
      const subtotal = orderTotal(order);
      const total = Math.round((subtotal * (1 + CGST + SGST)) * 100); // paise
      const rzpOrder = await rzpCreateOrder(total, order.id.slice(0, 40));
      return res.json({
        needsPayment: true,
        rzp: {
          key: RZP_KEY, orderId: rzpOrder.id, amount: rzpOrder.amount, currency: "INR",
          name: req.restaurant.name, description: `${req.restaurant.name} · ${tableById(req.restaurant, req.tableId).name}`,
          method
        }
      });
    } catch (e) {
      return res.status(502).json({ error: "Could not start online payment: " + e.message });
    }
  }

  // Recorded payment (no gateway / cash).
  settleBill(req.restaurant, order, method);
  order.status = "paid"; order.updatedAt = Date.now();
  store.save();
  broadcastOrder(order);
  res.json({ order: customerView(req.restaurant, order) });
});

// Verify a Razorpay payment, then settle the bill.
app.post("/api/order/pay/verify", requireCustomer, (req, res) => {
  const order = currentOrder(req.slug, req.tableId, req.sid);
  if (!order) return res.status(400).json({ error: "No order to pay for." });
  if (order.status === "paid") return res.json({ order: customerView(req.restaurant, order) });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, method } = req.body || {};
  if (!razorpayEnabled() || !rzpVerify(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    return res.status(400).json({ error: "Payment could not be verified." });
  }
  const bill = settleBill(req.restaurant, order, ["upi", "card"].includes(method) ? method : "upi");
  bill.paymentId = razorpay_payment_id;
  order.status = "paid"; order.updatedAt = Date.now();
  store.save();
  broadcastOrder(order);
  res.json({ order: customerView(req.restaurant, order) });
});

app.post("/api/order/clear", requireCustomer, (req, res) => {
  const order = currentOrder(req.slug, req.tableId, req.sid);
  if (order && order.status === "cart") {
    order.items = []; order.updatedAt = Date.now();
    store.save(); broadcastOrder(order);
  }
  res.json({ order: customerView(req.restaurant, currentOrder(req.slug, req.tableId, req.sid)) });
});

// Guest feedback — a 1–5 star rating + optional comment, attached to the order.
app.post("/api/order/feedback", requireCustomer, (req, res) => {
  const order = currentOrder(req.slug, req.tableId, req.sid);
  if (!order || order.status === "cart") {
    return res.status(400).json({ error: "Please place an order before leaving feedback." });
  }
  const rating = parseInt(req.body?.rating, 10);
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: "Please pick a 1–5 star rating." });
  const comment = String(req.body?.comment || "").slice(0, 500).trim();
  order.feedback = { rating, comment, at: Date.now() };
  order.updatedAt = Date.now();
  store.save();
  broadcastOrder(order);
  res.json({ order: customerView(req.restaurant, order) });
});

// ===========================================================================
// MANAGER API
// ===========================================================================
app.post("/api/manager/login", (req, res) => {
  const { password } = req.body || {};
  const slug = (req.body && req.body.slug) || store.defaultSlug();
  const key = `mgr:${req.ip}:${slug}`;
  if (tooManyAttempts(key)) return res.status(429).json({ error: "Too many attempts. Please wait a few minutes and try again." });
  const r = restaurantOf(slug);
  if (!r) return res.status(404).json({ error: "Restaurant not found." });
  if (!password || !store.verifyPassword(password, r.managerPassword)) return res.status(401).json({ error: "Incorrect password." });
  if (!store.isHashed(r.managerPassword)) { r.managerPassword = store.hashPassword(password); store.save(); }
  clearAttempts(key);
  const token = jwt.sign({ role: "manager", tenant: slug }, JWT_SECRET, { expiresIn: "12h" });
  res.cookie("mgr", token, { httpOnly: true, sameSite: "lax", maxAge: 12 * 36e5 });
  res.json({ ok: true, restaurant: publicRestaurant(r) });
});

app.post("/api/manager/logout", (req, res) => { res.clearCookie("mgr"); res.json({ ok: true }); });

app.get("/api/manager/session", requireManager, (req, res) => {
  res.json({ ok: true, restaurant: publicRestaurant(req.restaurant), payments: { razorpay: razorpayEnabled() } });
});

app.get("/api/manager/orders", requireManager, (req, res) => {
  const wantCleared = req.query.cleared === "1";
  const mine = Object.values(db().orders).filter((o) => o.tenant === req.slug && o.status !== "cart");
  // The live board is everything that hasn't been cleared/archived.
  const live = mine.filter((o) => !o.cleared).map(managerView)
    .sort((a, b) => (b.placedAt || b.createdAt) - (a.placedAt || a.createdAt));
  const shown = wantCleared
    ? mine.filter((o) => o.cleared).map(managerView)
        .sort((a, b) => (b.clearedAt || b.placedAt || b.createdAt) - (a.clearedAt || a.placedAt || a.createdAt))
    : live;
  const active = live.filter((o) => o.status !== "paid" && o.status !== "cancelled");
  res.json({
    orders: shown,
    clearedCount: mine.length - live.length,
    // Stats always reflect the LIVE board, so clearing it resets the headline numbers.
    stats: {
      totalOrders: live.length,
      activeOrders: active.length,
      activeTables: new Set(active.map((o) => o.tableId)).size,
      pendingRevenue: active.reduce((s, o) => s + o.total, 0),
      collected: live.filter((o) => o.status === "paid").reduce((s, o) => s + (o.bill ? o.bill.total : o.total), 0)
    }
  });
});

// Archive every order off the live board. Non-destructive: cleared orders stay
// viewable (and still count in Analytics) — clearing just declutters the board.
app.post("/api/manager/orders/clear", requireManager, (req, res) => {
  const now = Date.now();
  let cleared = 0;
  for (const o of Object.values(db().orders)) {
    if (o.tenant === req.slug && o.status !== "cart" && !o.cleared) {
      o.cleared = true; o.clearedAt = now; cleared++;
    }
  }
  store.save();
  res.json({ ok: true, cleared });
});

app.post("/api/manager/orders/:id/status", requireManager, (req, res) => {
  const order = db().orders[req.params.id];
  if (!order || order.tenant !== req.slug) return res.status(404).json({ error: "Order not found." });
  const { status } = req.body || {};
  if (![...STATUS_FLOW, "cancelled"].includes(status)) return res.status(400).json({ error: "Invalid status." });
  order.status = status; order.updatedAt = Date.now();
  if (status === "placed" && !order.placedAt) order.placedAt = Date.now();
  if (status === "paid") settleBill(req.restaurant, order, "cash");
  store.save();
  broadcastOrder(order);
  res.json({ order: managerView(order) });
});

// ---- menu editor (full-replace, validated) ----
app.get("/api/manager/menu", requireManager, (req, res) => res.json({ categories: req.restaurant.menu }));

app.put("/api/manager/menu", requireManager, (req, res) => {
  const incoming = req.body && req.body.categories;
  if (!Array.isArray(incoming) || !incoming.length) return res.status(400).json({ error: "Menu needs at least one category." });

  const usedItemIds = new Set();
  const usedCatIds = new Set();
  const clean = [];
  for (const c of incoming) {
    const name = String(c.name || "").trim();
    if (!name) continue;
    let cid = store.slugify(c.id || name);
    while (usedCatIds.has(cid)) cid += "-x";
    usedCatIds.add(cid);
    const items = [];
    for (const it of c.items || []) {
      const iname = String(it.name || "").trim();
      const price = Number(it.price);
      if (!iname || !(price >= 0)) continue;
      let iid = store.slugify(it.id || iname);
      while (usedItemIds.has(iid)) iid += "-x";
      usedItemIds.add(iid);
      const badges = Array.isArray(it.badges) ? it.badges.filter((b) => ["spicy", "gf"].includes(b)) : [];
      items.push({
        id: iid, name: iname.slice(0, 60), price: Math.round(price),
        emoji: String(it.emoji || "🍽️").slice(0, 4),
        veg: it.veg !== false,
        desc: String(it.desc || "").slice(0, 240),
        img: String(it.img || "").slice(0, 400),
        badges,
        bestseller: !!it.bestseller, special: !!it.special
      });
    }
    clean.push({
      id: cid, name: name.slice(0, 40), icon: String(c.icon || "🍽️").slice(0, 4),
      tagline: String(c.tagline || "").slice(0, 80),
      theme: c.theme && typeof c.theme === "object" ? c.theme : { from: "#d4af37", to: "#b8901f", glow: "#ffe2a8" },
      anim: c.anim || "float",
      items
    });
  }
  if (!clean.length) return res.status(400).json({ error: "No valid categories." });
  req.restaurant.menu = clean;
  store.save();
  res.json({ ok: true, categories: clean });
});

// ---- restaurant settings ----
app.put("/api/manager/restaurant", requireManager, (req, res) => {
  const b = req.body || {};
  const r = req.restaurant;
  for (const f of ["name", "tagline", "address", "phone", "gstin", "fssai", "reviewUrl"]) {
    if (typeof b[f] === "string") r[f] = b[f].slice(0, 200);
  }
  if (typeof b.managerPassword === "string" && b.managerPassword.length >= 4) r.managerPassword = store.hashPassword(b.managerPassword.slice(0, 64));
  store.save();
  res.json({ ok: true, restaurant: publicRestaurant(r) });
});

// ---- analytics ----
app.get("/api/manager/analytics", requireManager, (req, res) => {
  const paid = Object.values(db().orders).filter((o) => o.tenant === req.slug && o.status === "paid");
  const itemAgg = {};
  let revenue = 0;
  const byHour = Array(24).fill(0);
  const byDay = {}; // yyyy-mm-dd -> revenue
  const methods = {};
  for (const o of paid) {
    const total = o.bill ? o.bill.total : orderTotal(o);
    revenue += total;
    for (const it of o.items) {
      const a = (itemAgg[it.itemId] = itemAgg[it.itemId] || { name: it.name, emoji: it.emoji, qty: 0, revenue: 0 });
      a.qty += it.qty; a.revenue += it.price * it.qty;
    }
    const ts = o.paidAt || o.updatedAt;
    const d = new Date(ts);
    byHour[d.getHours()] += total;
    const key = d.toISOString().slice(0, 10);
    byDay[key] = (byDay[key] || 0) + total;
    const m = (o.bill && o.bill.method) || "other";
    methods[m] = (methods[m] || 0) + 1;
  }
  const topItems = Object.values(itemAgg).sort((a, b) => b.qty - a.qty).slice(0, 8);
  // last 7 days series
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const key = d.toISOString().slice(0, 10);
    days.push({ day: d.toLocaleDateString("en-IN", { weekday: "short" }), date: key, revenue: Math.round(byDay[key] || 0) });
  }
  res.json({
    totals: {
      revenue: Math.round(revenue),
      orders: paid.length,
      avgOrder: paid.length ? Math.round(revenue / paid.length) : 0
    },
    topItems, byHour, days, methods
  });
});

// ---- tables + QR ----
app.get("/api/manager/tables", requireManager, async (req, res) => {
  const out = [];
  for (const t of req.restaurant.tables) {
    const url = tableUrl(req, req.slug, t);
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 320, color: { dark: "#1a1408", light: "#ffffff" } });
    out.push({ id: t.id, name: t.name, url, qr });
  }
  res.json({ tables: out });
});

app.post("/api/manager/tables", requireManager, (req, res) => {
  const count = Math.max(1, Math.min(100, parseInt(req.body?.count, 10) || 0));
  const existing = req.restaurant.tables;
  const tables = [];
  for (let i = 1; i <= count; i++) {
    const prev = existing.find((t) => t.id === i);
    tables.push({ id: i, name: `Table ${i}`, token: (prev && prev.token) || store.makeToken() });
  }
  req.restaurant.tables = tables;
  store.save();
  res.json({ ok: true, count });
});

// Legacy single-table PNG (default restaurant).
app.get("/qr/:id", async (req, res) => {
  const r = restaurantOf(store.defaultSlug());
  const table = tableById(r, req.params.id);
  if (!table) return res.status(404).send("Unknown table");
  res.type("png");
  res.send(await QRCode.toBuffer(tableUrl(req, r.slug, table), { margin: 1, width: 400, color: { dark: "#1a1408", light: "#ffffff" } }));
});

// ===========================================================================
// SUPER-ADMIN API
// ===========================================================================
app.post("/api/admin/login", (req, res) => {
  const key = `adm:${req.ip}`;
  if (tooManyAttempts(key)) return res.status(429).json({ error: "Too many attempts. Please wait a few minutes and try again." });
  if ((req.body || {}).password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Incorrect admin password." });
  clearAttempts(key);
  const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "8h" });
  res.cookie("adm", token, { httpOnly: true, sameSite: "lax", maxAge: 8 * 36e5 });
  res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => { res.clearCookie("adm"); res.json({ ok: true }); });
app.get("/api/admin/session", requireAdmin, (req, res) => res.json({ ok: true }));

app.get("/api/admin/restaurants", requireAdmin, (req, res) => {
  const orders = Object.values(db().orders);
  res.json({
    restaurants: store.listRestaurants().map((r) => ({
      slug: r.slug, name: r.name, tagline: r.tagline,
      tables: r.tables.length,
      menuItems: r.menu.reduce((n, c) => n + (c.items ? c.items.length : 0), 0),
      orders: orders.filter((o) => o.tenant === r.slug && o.status !== "cart").length,
      createdAt: r.createdAt,
      managerUrl: `${baseUrl(req)}/r/${r.slug}/manager`
    }))
  });
});

app.post("/api/admin/restaurants", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.name || String(b.name).trim().length < 2) return res.status(400).json({ error: "Name is required." });
  if (!b.password || String(b.password).length < 4) return res.status(400).json({ error: "Manager password (min 4 chars) is required." });
  const r = store.createRestaurant({
    name: String(b.name).trim(),
    tagline: b.tagline, address: b.address, phone: b.phone,
    gstin: b.gstin, fssai: b.fssai, reviewUrl: b.reviewUrl,
    managerPassword: String(b.password),
    tableCount: Math.max(1, Math.min(100, parseInt(b.tableCount, 10) || 8))
  });
  res.json({ ok: true, slug: r.slug, managerUrl: `${baseUrl(req)}/r/${r.slug}/manager` });
});

app.delete("/api/admin/restaurants/:slug", requireAdmin, (req, res) => {
  const d = db();
  if (!d.restaurants[req.params.slug]) return res.status(404).json({ error: "Not found." });
  if (Object.keys(d.restaurants).length <= 1) return res.status(400).json({ error: "Can't delete the last restaurant." });
  delete d.restaurants[req.params.slug];
  for (const [id, o] of Object.entries(d.orders)) if (o.tenant === req.params.slug) delete d.orders[id];
  store.save();
  res.json({ ok: true });
});

// ===========================================================================
// SOCKET.IO — authenticated, tenant-scoped rooms
// ===========================================================================
io.on("connection", (socket) => {
  const parsed = cookieLib.parse(socket.handshake.headers.cookie || "");
  if (parsed.mgr) {
    try {
      const payload = jwt.verify(parsed.mgr, JWT_SECRET);
      if (payload.tenant) socket.join(`managers:${payload.tenant}`);
    } catch { /* ignore */ }
  }
  if (parsed.sid) {
    const unsigned = cookieParser.signedCookie(decodeURIComponent(parsed.sid), COOKIE_SECRET);
    if (unsigned) socket.join(`sid:${unsigned}`);
  }
});

// ---------------------------------------------------------------------------
function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) for (const net of nets[name] || []) if (net.family === "IPv4" && !net.internal) out.push(net.address);
  return out;
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("\n  🏰  Anand Palace platform is live\n");
  console.log(`  Super-admin   : http://localhost:${PORT}/admin   (password: ${ADMIN_PASSWORD})`);
  console.log(`  Manager       : http://localhost:${PORT}/manager`);
  console.log(`  Payments      : ${razorpayEnabled() ? "Razorpay (live keys detected)" : "recorded only (set RAZORPAY_KEY_ID/SECRET for online payments)"}`);
  const lan = lanAddresses();
  if (lan.length) {
    console.log(`\n  On the same Wi-Fi: http://${lan[0]}:${PORT}/manager`);
    console.log(`  (Print QR codes from the dashboard so they point at this address.)`);
  }
  console.log("");
});
