/* sync-menu — bring every restaurant's SAVED menu up to date with lib/menu.js.
 *
 * lib/menu.js is only the seed: once a restaurant exists its menu lives in the store, so new
 * courses, new dishes and re-shot photography have to be merged into the saved copy or the
 * guest page keeps serving yesterday's card.
 *
 * Merge rules (deliberately conservative — a live restaurant may have edited its own menu):
 *   • new category in the seed        -> added
 *   • new dish in an existing course  -> added
 *   • dish that already exists        -> photo path refreshed, name/price/description LEFT ALONE
 *   • dish the restaurant added itself-> untouched
 * Run: npm run photos:sync
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { CATEGORIES } = require('../lib/menu');

const DB = path.join(__dirname, '..', 'data', 'db.json');
const clone = (v) => JSON.parse(JSON.stringify(v));

const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
let addedCats = 0, addedItems = 0, rephotos = 0;

for (const [slug, r] of Object.entries(db.restaurants || {})) {
  if (!Array.isArray(r.menu)) r.menu = [];
  for (const seedCat of CATEGORIES) {
    let cat = r.menu.find((c) => c.id === seedCat.id);
    if (!cat) {
      r.menu.push(clone(seedCat));
      addedCats++;
      addedItems += seedCat.items.length;
      continue;
    }
    if (!Array.isArray(cat.items)) cat.items = [];
    for (const seedItem of seedCat.items) {
      const item = cat.items.find((i) => i.id === seedItem.id);
      if (!item) { cat.items.push(clone(seedItem)); addedItems++; continue; }
      if (seedItem.img && item.img !== seedItem.img) { item.img = seedItem.img; rephotos++; }
    }
  }
  console.log('  ' + slug + ': ' + r.menu.length + ' courses, '
    + r.menu.reduce((n, c) => n + (c.items || []).length, 0) + ' dishes');
}

fs.writeFileSync(DB, JSON.stringify(db, null, 2));
console.log('added ' + addedCats + ' courses, ' + addedItems + ' dishes; refreshed ' + rephotos + ' photos');
console.log('restart the server for guests to see them.');
