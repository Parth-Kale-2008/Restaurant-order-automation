/* tidy-menu — clean the saved menu so guests never see a broken card.
 *
 *   • drops EMPTY courses (the manager UI can create "New Category" placeholders that were
 *     never filled — they render as dead tabs on the guest page)
 *   • merges courses that share a NAME (a restaurant renamed the seed "main-veg" to
 *     "main-course", so syncing the seed produced two "Main Course" tabs); dishes are merged
 *     by id into the first course, the duplicate is removed
 *
 * Run: npm run menu:tidy
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DB = path.join(__dirname, '..', 'data', 'db.json');

const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
let dropped = 0, merged = 0, movedItems = 0;

for (const [slug, r] of Object.entries(db.restaurants || {})) {
  if (!Array.isArray(r.menu)) continue;
  // merge duplicates by display name (first one wins — it is the one guests already know)
  const byName = new Map();
  for (const cat of r.menu) {
    const key = String(cat.name || '').trim().toLowerCase();
    if (!byName.has(key)) { byName.set(key, cat); continue; }
    const keep = byName.get(key);
    const have = new Set((keep.items || []).map((i) => i.id));
    for (const item of cat.items || []) {
      if (have.has(item.id)) continue;
      keep.items.push(item);
      have.add(item.id);
      movedItems++;
    }
    cat.__drop = true;
    merged++;
  }
  const before = r.menu.length;
  r.menu = r.menu.filter((c) => !c.__drop && Array.isArray(c.items) && c.items.length > 0);
  dropped += before - r.menu.length - merged;
  console.log('  ' + slug + ': ' + r.menu.length + ' courses, '
    + r.menu.reduce((n, c) => n + c.items.length, 0) + ' dishes');
}

fs.writeFileSync(DB, JSON.stringify(db, null, 2));
console.log('merged ' + merged + ' duplicate courses (' + movedItems + ' dishes moved), dropped ' + dropped + ' empty ones');
