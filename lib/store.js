// Multi-tenant JSON-file datastore. No native deps, survives restarts.
// Holds many restaurants (each with its own menu, tables, settings & invoice
// counter) plus a global orders map (each order tagged with its restaurant slug).
// Writes are debounced to disk.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { CATEGORIES } = require("./menu"); // used only as the seed menu for new restaurants

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const SECRETS_FILE = path.join(DATA_DIR, "secrets.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// ---- secrets --------------------------------------------------------------
// Cookie/JWT signing keys. An env var always wins; otherwise we generate once
// and persist to disk so sessions survive restarts (instead of a fresh random
// key per boot that logs everyone out on every deploy).
function getSecret(name, envVal) {
  if (envVal) return envVal;
  ensureDir();
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8")); } catch { /* first run */ }
  if (!s[name]) {
    s[name] = crypto.randomBytes(32).toString("hex");
    try { fs.writeFileSync(SECRETS_FILE, JSON.stringify(s, null, 2)); }
    catch (e) { console.error("Could not persist secret:", e.message); }
  }
  return s[name];
}

// ---- password hashing (scrypt; no native deps) ----------------------------
const SCRYPT_KEYLEN = 32;
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const dk = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN).toString("hex");
  return `scrypt$${salt}$${dk}`;
}
function isHashed(stored) {
  return typeof stored === "string" && stored.startsWith("scrypt$");
}
function verifyPassword(plain, stored) {
  if (!stored) return false;
  const parts = String(stored).split("$");
  if (parts[0] === "scrypt" && parts.length === 3) {
    const dk = crypto.scryptSync(String(plain), parts[1], SCRYPT_KEYLEN).toString("hex");
    const a = Buffer.from(dk), b = Buffer.from(parts[2]);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return String(plain) === String(stored); // legacy plaintext (upgraded on next load/login)
}

// Each table carries an unguessable token; its printed QR encodes it, so typing
// a table number by hand can't seat you at someone else's table.
function makeToken() {
  return crypto.randomBytes(6).toString("hex");
}

function seedTables(n) {
  const tables = [];
  for (let i = 1; i <= n; i++) tables.push({ id: i, name: `Table ${i}`, token: makeToken() });
  return tables;
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "restaurant";
}

// A fresh restaurant record. `menu` is seeded from lib/menu.js but lives in the
// datastore from here on, so managers can edit it at runtime.
function makeRestaurant(opts = {}) {
  const name = opts.name || "New Restaurant";
  return {
    slug: opts.slug || slugify(name),
    name,
    tagline: opts.tagline || "Fine Dining",
    address: opts.address || "",
    phone: opts.phone || "",
    gstin: opts.gstin || "",
    fssai: opts.fssai || "",
    reviewUrl: opts.reviewUrl || "",
    managerPassword: hashPassword(opts.managerPassword || "anand123"),
    menu: opts.menu ? clone(opts.menu) : clone(CATEGORIES),
    tables: seedTables(opts.tableCount || 12),
    invoiceSeq: 0,
    createdAt: Date.now()
  };
}

function defaultDb() {
  const anand = makeRestaurant({
    slug: "anand-palace",
    name: "Anand Palace",
    tagline: "Fine Indian Dining",
    address: "12 Heritage Road, Indore, MP 452001",
    phone: "+91 98765 43210",
    gstin: "23ABCDE1234F1Z5",
    fssai: "11522998000234",
    reviewUrl: "https://www.google.com/maps/search/?api=1&query=Anand+Palace+Indore",
    managerPassword: process.env.MANAGER_PASSWORD || "anand123"
  });
  return { restaurants: { [anand.slug]: anand }, orders: {} };
}

let db;

function load() {
  ensureDir();
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      migrate(db);
    } catch (e) {
      console.error("DB corrupt, starting fresh:", e.message);
      db = defaultDb();
    }
  } else {
    db = defaultDb();
  }
  save();
  return db;
}

// Bring older single-restaurant databases up to the multi-tenant shape.
function migrate(d) {
  if (!d.restaurants) {
    // Old shape: { tables, orders, invoiceSeq }  ->  wrap into the default restaurant.
    const def = defaultDb().restaurants["anand-palace"];
    if (Array.isArray(d.tables)) def.tables = d.tables;
    if (typeof d.invoiceSeq === "number") def.invoiceSeq = d.invoiceSeq;
    d.restaurants = { "anand-palace": def };
    delete d.tables;
    delete d.invoiceSeq;
  }
  if (!d.orders) d.orders = {};
  // Per-restaurant invariants.
  for (const r of Object.values(d.restaurants)) {
    if (!Array.isArray(r.menu) || !r.menu.length) r.menu = clone(CATEGORIES);
    if (!Array.isArray(r.tables)) r.tables = seedTables(12);
    for (const t of r.tables) if (!t.token) t.token = makeToken();
    if (typeof r.invoiceSeq !== "number") r.invoiceSeq = 0;
    if (!r.managerPassword) r.managerPassword = "anand123";
    // Upgrade any legacy plaintext password to a salted scrypt hash, in place.
    if (!isHashed(r.managerPassword)) r.managerPassword = hashPassword(r.managerPassword);
  }
  // Tag any untagged orders with the first restaurant (legacy single-tenant orders).
  const firstSlug = Object.keys(d.restaurants)[0];
  for (const o of Object.values(d.orders)) if (!o.tenant) o.tenant = firstSlug;
}

// Optional listener (e.g. the MongoDB mirror) notified after each disk write.
let persistHook = null;
function onPersist(fn) { persistHook = fn; }

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      // Atomic write: serialise to a temp file, then rename over the real one.
      // A crash mid-write can't corrupt or truncate db.json this way.
      const tmp = DB_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error("Failed to persist DB:", e.message);
    }
    if (persistHook) { try { persistHook(db); } catch (e) { console.error("persist hook failed:", e.message); } }
  }, 150);
}

function getDb() {
  if (!db) load();
  return db;
}

// ---- restaurant helpers ---------------------------------------------------
function getRestaurant(slug) {
  return getDb().restaurants[slug] || null;
}
function defaultSlug() {
  return Object.keys(getDb().restaurants)[0] || "anand-palace";
}
function listRestaurants() {
  return Object.values(getDb().restaurants);
}
function createRestaurant(opts) {
  const d = getDb();
  let slug = opts.slug || slugify(opts.name);
  // ensure unique slug
  let base = slug, n = 2;
  while (d.restaurants[slug]) slug = `${base}-${n++}`;
  const r = makeRestaurant({ ...opts, slug });
  d.restaurants[slug] = r;
  save();
  return r;
}

module.exports = {
  load, save, getDb, makeToken, slugify,
  getRestaurant, defaultSlug, listRestaurants, createRestaurant,
  getSecret, hashPassword, verifyPassword, isHashed, onPersist
};
