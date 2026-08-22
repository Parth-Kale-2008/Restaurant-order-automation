// ---------------------------------------------------------------------------
// MongoDB mirror.
// The app's source of truth stays the fast local JSON store (lib/store.js).
// This module keeps a live, queryable COPY of that state in a MongoDB database
// named "anand-palace" so everything is browsable in Compass / mongosh.
//
//   • collection "restaurants" — one doc per restaurant (keyed by slug)
//   • collection "orders"      — one doc per order        (keyed by id)
//
// Sync is one-way (app -> Mongo), debounced, and non-fatal: if Mongo is down
// the restaurant app keeps running on the JSON store alone.
// ---------------------------------------------------------------------------
const { MongoClient } = require("mongodb");

const URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.MONGODB_DB || "anand-palace";

let client = null;
let database = null;
let connected = false;

// Coalesce bursts of saves into one sync at a time.
let syncing = false;
let queued = false;
let pending = null;

async function connect() {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  database = client.db(DB_NAME);
  await database.collection("restaurants").createIndex({ slug: 1 }, { unique: true });
  await database.collection("orders").createIndex({ id: 1 }, { unique: true });
  connected = true;
  return { uri: URI, db: DB_NAME };
}

function isConnected() { return connected; }

// Upsert the whole app state, and drop any docs that no longer exist locally
// (so deletions — e.g. removed test orders — are reflected too).
async function runSync(snap) {
  const restaurants = Object.values(snap.restaurants || {});
  const orders = Object.values(snap.orders || {});

  if (restaurants.length) {
    await database.collection("restaurants").bulkWrite(
      restaurants.map((r) => ({ updateOne: { filter: { slug: r.slug }, update: { $set: r }, upsert: true } }))
    );
  }
  if (orders.length) {
    await database.collection("orders").bulkWrite(
      orders.map((o) => ({ updateOne: { filter: { id: o.id }, update: { $set: o }, upsert: true } }))
    );
  }

  const slugs = restaurants.map((r) => r.slug);
  const ids = orders.map((o) => o.id);
  await database.collection("restaurants").deleteMany({ slug: { $nin: slugs.length ? slugs : ["__none__"] } });
  await database.collection("orders").deleteMany({ id: { $nin: ids.length ? ids : ["__none__"] } });
}

// Public entry point: schedule a sync of the given JSON-store snapshot.
function sync(snap) {
  if (!connected) return;
  pending = snap;
  if (syncing) { queued = true; return; }
  syncing = true;
  (async () => {
    try {
      do {
        queued = false;
        const snapshot = pending;
        await runSync(snapshot);
      } while (queued);
    } catch (e) {
      console.error("Mongo sync error:", e.message);
    } finally {
      syncing = false;
    }
  })();
}

/* Read the whole dataset back OUT of Mongo.
   Until this existed, lib/mongo.js was a one-way mirror: sync() pushed the local JSON store up
   and runSync() ended with deleteMany({ $nin: <local ids> }). On a host with an ephemeral disk
   (Render free tier) the local store boots as a fresh SEED, so that first sync deleted every
   real restaurant and order FROM MONGO. Measured: 2 restaurants + 18 orders -> 1 + 0 after one
   simulated restart. Mongo has to be readable for it to be a backup at all. */
async function loadAll() {
  if (!connected) return null;
  const [restaurants, orders] = await Promise.all([
    database.collection("restaurants").find({}).toArray(),
    database.collection("orders").find({}).toArray()
  ]);
  if (!restaurants.length) return null;          // nothing stored yet -> caller keeps local
  const snap = { restaurants: {}, orders: {} };
  for (const r of restaurants) { delete r._id; snap.restaurants[r.slug] = r; }
  for (const o of orders) { delete o._id; snap.orders[o.id] = o; }
  return snap;
}

async function close() { if (client) await client.close(); connected = false; }

module.exports = { connect, sync, loadAll, isConnected, close, DB_NAME, URI };
