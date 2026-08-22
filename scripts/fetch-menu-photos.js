/* fetch-menu-photos — real, self-hosted dish photography for the Anand Palace menu.
 *
 * Why this exists: the menu shipped with hot-linked Unsplash URLs, 8 of which had already
 * 404'd (the customer saw an emoji medallion instead of the dish). Hot-linked photos are a
 * liability on a live restaurant menu — they can vanish without warning and they cost a
 * round-trip to a third party on every scan of a table QR.
 *
 * This pulls freely-licensed photographs of the ACTUAL dish from Wikimedia Commons, verifies
 * each file is a real bitmap of usable size, writes them under public/img/menu/<id>.jpg, and
 * records photographer + licence for the credits page. Run: npm run photos
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { CATEGORIES } = require('../lib/menu');

const OUT_DIR = path.join(__dirname, '..', 'public', 'img', 'menu');
const CREDITS = path.join(__dirname, '..', 'data', 'photo-credits.json');
const UA = 'AnandPalaceMenu/1.0 (restaurant menu; contact: owner@anandpalace.example)';

/* Per-dish search terms. The dish name alone is ambiguous for a few items ("Crispy Corn" finds
 * corn fields), so each carries a short list tried in order — first usable hit wins. */
const QUERIES = {
  'veg-spring-roll': ['vegetable spring roll plate', 'spring roll fried snack'],
  'paneer-tikka': ['paneer tikka', 'panir tikka grilled'],
  'crispy-corn': ['crispy corn snack', 'corn kernels fried snack india'],
  'veg-manchurian-dry': ['veg manchurian dry', 'vegetable manchurian'],
  'chicken-tikka': ['chicken tikka', 'chicken tikka grilled'],
  'chicken-lollipop': ['chicken lollipop', 'chicken drumstick fried'],
  'dal-tadka': ['dal tadka', 'dal fry tadka bowl'],
  'dal-fry': ['dal fry', 'yellow dal indian'],
  'jeera-aloo': ['jeera aloo', 'potato cumin fry indian'],
  'mix-veg-curry': ['mixed vegetable curry indian', 'mix veg sabzi'],
  'kadai-paneer': ['kadai paneer', 'paneer curry karahi'],
  'shahi-paneer': ['shahi paneer', 'paneer curry cream'],
  'paneer-butter-masala': ['paneer butter masala', 'butter paneer curry'],
  'veg-kolhapuri': ['veg kolhapuri', 'kolhapuri curry'],
  'plain-roti': ['Fresh Roti Indian flour bread', 'Indian Breads Roti', 'chapati plate'],
  'butter-roti': ['Tandoori-roti', 'Tandoori Roti-MB54', 'tandoori rotis'],
  'tandoori-roti': ['tandoori roti', 'roti tandoor bread'],
  'butter-naan': ['butter naan', 'naan bread indian'],
  'garlic-naan': ['garlic naan', 'naan garlic bread'],
  'steam-rice': ['steamed rice bowl', 'plain boiled rice plate'],
  'jeera-rice': ['jeera rice', 'cumin rice indian'],
  'veg-pulao': ['vegetable pulao', 'pulao rice indian'],
  'veg-biryani': ['vegetable biryani', 'veg biryani plate'],
  'paneer-biryani': ['paneer biryani', 'biryani paneer rice'],
  'chicken-biryani': ['chicken biryani', 'biryani chicken plate'],
  'mutton-biryani': ['mutton biryani', 'lamb biryani'],
  'veg-noodles': ['vegetable noodles indo chinese', 'veg noodles plate'],
  'hakka-noodles': ['hakka noodles', 'chow mein noodles vegetable'],
  'schezwan-noodles': ['schezwan noodles', 'szechuan noodles'],
  'veg-fried-rice': ['vegetable fried rice', 'fried rice plate'],
  'schezwan-fried-rice': ['schezwan fried rice', 'szechuan fried rice'],
  'paneer-chilli': ['chilli paneer', 'paneer chilli indo chinese'],
  // second course expansion
  'hara-bhara-kabab': ['hara bhara kabab', 'spinach cutlet indian'],
  'aloo-tikki-chaat': ['aloo tikki chaat', 'aloo tikki'],
  'chilli-mushroom': ['chilli mushroom', 'mushroom manchurian'],
  'palak-paneer': ['palak paneer', 'saag paneer'],
  'malai-kofta': ['malai kofta', 'kofta curry indian'],
  'chana-masala': ['chana masala', 'chole chickpea curry'],
  'lachha-paratha': ['lachha paratha', 'paratha layered indian bread'],
  'cheese-naan': ['cheese naan', 'stuffed naan'],
  'missi-roti': ['missi roti', 'besan roti'],
  'curd-rice': ['curd rice', 'thayir sadam'],
  'egg-fried-rice': ['egg fried rice', 'fried rice egg'],
  'veg-manchurian-gravy': ['manchurian gravy', 'vegetable manchurian gravy'],
  'chilli-garlic-noodles': ['garlic noodles', 'chilli noodles'],
  'tomato-shorba': ['tomato shorba', 'tomato soup bowl homemade'],
  'sweet-corn-soup': ['sweet corn soup', 'corn soup bowl'],
  'manchow-soup': ['manchow soup', 'noodle soup indian chinese'],
  'hot-and-sour-soup': ['hot and sour soup', 'sour soup bowl'],
  'tandoori-chicken': ['tandoori chicken', 'tandoori chicken plate'],
  'chicken-malai-tikka': ['malai tikka chicken', 'chicken tikka skewer'],
  'paneer-malai-tikka': ['malai paneer tikka', 'paneer skewer'],
  'tandoori-mushroom': ['tandoori mushroom', 'grilled mushroom skewer'],
  'mutton-seekh-kebab': ['seekh kebab', 'mutton kebab skewer'],
  'butter-chicken': ['butter chicken', 'murgh makhani'],
  'kadai-chicken': ['kadai chicken', 'chicken karahi'],
  'chicken-curry': ['chicken curry', 'murgh curry indian', 'chicken gravy dish'],
  'mutton-rogan-josh': ['rogan josh', 'mutton curry kashmiri'],
  'egg-curry': ['egg curry', 'anda curry'],
  'boondi-raita': ['boondi raita', 'raita yogurt indian'],
  'green-salad': ['indian salad onion cucumber', 'green salad plate'],
  'masala-papad': ['masala papad', 'papad indian'],
  'pickle-platter': ['mango pickle indian', 'achar pickle'],
  'gulab-jamun': ['gulab jamun', 'gulab jamun bowl'],
  'rasmalai': ['rasmalai', 'ras malai dessert'],
  'gajar-halwa': ['gajar halwa', 'carrot halwa'],
  'kheer': ['rice kheer', 'kheer payasam'],
  'vanilla-ice-cream': ['ice cream scoops bowl', 'vanilla ice cream'],
  'masala-chai': ['masala chai', 'indian tea glass'],
  'filter-coffee': ['filter coffee india', 'south indian coffee tumbler'],
  'sweet-lassi': ['lassi glass', 'sweet lassi'],
  'mango-lassi': ['mango lassi', 'mango yogurt drink'],
  'fresh-lime-soda': ['lime soda glass', 'nimbu pani'],
  'chaas': ['buttermilk chaas', 'masala chaas glass'],
};

const get = (url, opts = {}) => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'User-Agent': UA, ...(opts.headers || {}) } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      return resolve(get(res.headers.location, opts));
    }
    if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ buf: Buffer.concat(chunks), type: res.headers['content-type'] || '' }));
  }).on('error', reject);
});

async function search(term, tier) {
  // Tier 1 = Commons' curated "Quality images" (peer-reviewed for sharpness, lighting and
  // composition). A menu photographed like a phone snapshot cheapens the whole page, so the
  // curated pool is tried first and the open pool only as a fallback.
  const scope = tier === 'quality' ? 'incategory:"Quality images" ' : '';
  const u = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search'
    + '&gsrsearch=' + encodeURIComponent('filetype:bitmap ' + scope + term)
    + '&gsrlimit=8&gsrnamespace=6&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=1000&format=json';
  const { buf } = await get(u);
  const j = JSON.parse(buf.toString('utf8'));
  const pages = (j.query && j.query.pages) || {};
  return Object.values(pages).map((p) => {
    const i = (p.imageinfo && p.imageinfo[0]) || {};
    const m = i.extmetadata || {};
    const plain = (v) => String((v && v.value) || '').replace(/<[^>]+>/g, '').trim();
    return {
      title: String(p.title || '').replace(/^File:/, ''),
      url: i.thumburl, w: i.thumbwidth, h: i.thumbheight, mime: i.mime,
      artist: plain(m.Artist) || 'Wikimedia Commons contributor',
      licence: plain(m.LicenseShortName) || 'see Commons',
      page: i.descriptionurl || '',
    };
  }).filter((x) => x.url && /jpeg|png|webp/i.test(x.mime || ''));
}

/* The file must actually LOOK like the dish. Substring matching was far too generous — it gave
 * Masala Chai a photo of "Wan Chai" (a Hong Kong district) and Fresh Lime Soda a photo of
 * "Soda-lime window glass". Words must match on WORD BOUNDARIES, and most of the dish's words
 * have to be present, not just one. */
const NON_FOOD = /\b(window|glass process|float glass|district|street|station|museum|building|map|logo|coin|stamp|poster|sign|portrait|church|temple|bridge|factory|machine)\b/i;
function relevance(title, term) {
  const t = title.toLowerCase();
  const words = term.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (!words.length) return 0;
  if (NON_FOOD.test(title)) return 0;
  const hit = words.filter((w) => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(t)).length;
  // one lonely word out of three is how "chai" matched "Wan Chai"
  return hit >= Math.max(1, Math.ceil(words.length * 0.6)) ? hit : 0;
}

/* DIETARY GUARD — the menu shows a green "veg" badge on these dishes, so a photo of a prawn
 * platter or mutton noodles is not a cosmetic miss, it is a false claim on a live menu.
 * (First pass really did land prawn on Paneer Biryani and mutton on Hakka Noodles.) */
const MEAT_RE = /\b(chicken|mutton|lamb|beef|pork|prawn|shrimp|fish|egg|eggs|omelette|meat|keema|kebab|seekh|bacon|ham)\b/i;
const PROTEIN_OF = { 'chicken-tikka': /chicken/i, 'chicken-lollipop': /chicken/i,
  'chicken-biryani': /chicken/i, 'mutton-biryani': /mutton|lamb/i };

/* A starter is not a curry: "Chicken Tikka" must not land a tikka MASALA bowl, and a bread
 * must not land a thali where the bread is a bystander. */
const EXCLUDE = {
  'chicken-tikka': /masala|curry|gravy|sauce/i,
  'paneer-tikka': /masala|curry|gravy/i,
  'butter-naan': /paneer|curry|thali|combo|rice/i,
  'garlic-naan': /curry|thali|combo/i,
  // "roti" is a whole family across Asia — a Malaysian roti tisu cone is not butter roti
  'butter-roti': /daal|dal|thali|combo|assorted|tisu|canai|prata|cane|kari|aceh|jala|clay oven|baking/i,
  // documentary shots of someone COOKING are not appetite cues on a menu
  'plain-roti': /theater|spektakel|festival|making|kibera|kenya|backen|curry with|salsa/i,
  'tandoori-roti': /thali|combo/i,
  'schezwan-noodles': /fried rice|pasta|live/i,
  'hakka-noodles': /manchurian|combo/i,
  'paneer-chilli': /noodles|combo/i,
  'paneer-biryani': /prawn|combo|lunch plate/i,
  'schezwan-fried-rice': /raitha|egg/i,
  'shahi-paneer': /palak/i,
  'paneer-butter-masala': /rotti|roti|naan/i,
  'jeera-aloo': /sprouts|dal/i,
  // "made by me" phone snapshots read as amateur next to real food photography
  'crispy-corn': /field|cob|plant|farm|cornflakes/i,
  // a title can name BOTH proteins ("mutton biryani served with chicken curry") and slip past
  // the protein filter — the chicken and mutton dishes ended up sharing one mutton photo
  'chicken-biryani': /mutton|lamb|goat/i,
  'mutton-biryani': /chicken/i,
  // second-pass corrections, each from an actually-wrong result
  'tandoori-chicken': /qaurma|korma|curry|masala|biryani/i,
  'egg-fried-rice': /pineapple|vegetable/i,
  'chilli-garlic-noodles': /miso|soup|organic whole|spring garlic/i,
  'green-salad': /daal|dal|bread|assorted|burger/i,
  'masala-chai': /wan chai|hong kong|kowloon|street|shop/i,
  'fresh-lime-soda': /window|glass|bottle plant|lime kiln|cement/i,
  'mango-lassi': /pakora|thali|combo|platter/i,
  'tomato-shorba': /sourdough|bread bowl|sandwich|campbell|condensed|can|tin|packet|label/i,
  'mutton-seekh-kebab': /gobi|beef|aloo|platter/i,
  'vanilla-ice-cream': /waffle|banana|toffee|cone stand/i,
  'pickle-platter': /green indian mango|tree|raw mango|unripe/i,
  'chicken-curry': /tikka masala|qaurma|biryani/i,
};

/* one photo per dish: the same plate appearing twice on a menu reads as a stock-photo page */
const USED = new Set();

async function pick(id, name, veg) {
  const terms = QUERIES[id] || [name];
  for (const tier of ['quality', 'any']) {
    for (const term of terms) {
      let hits = [];
      try { hits = await search(term, tier); } catch (e) { continue; }
      hits = hits
        .map((h) => ({ ...h, score: relevance(h.title, term) }))
        .filter((h) => h.w >= 640 && h.score > 0)
        .filter((h) => !USED.has(h.title))                                       // no repeats
        .filter((h) => (veg ? !MEAT_RE.test(h.title) : true))                    // veg stays veg
        .filter((h) => (PROTEIN_OF[id] ? PROTEIN_OF[id].test(h.title) : true))   // the right protein
        .filter((h) => !(EXCLUDE[id] && EXCLUDE[id].test(h.title)))              // right FORM of the dish
        .sort((a, b) => b.score - a.score || b.w - a.w);
      for (const h of hits.slice(0, 3)) {
        try {
          const { buf, type } = await get(h.url);
          if (buf.length < 45000 || !/image/i.test(type)) continue;   // thumbnails/snapshots out
          USED.add(h.title);
          return { ...h, buf, tier };
        } catch (e) { /* next candidate */ }
      }
    }
  }
  return null;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(CREDITS), { recursive: true });
  // `node scripts/fetch-menu-photos.js butter-roti plain-roti` re-shoots just those dishes and
  // leaves every approved photo alone (with the already-used titles reserved, so no repeats)
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const credits = (() => { try { return JSON.parse(fs.readFileSync(CREDITS, 'utf8')); } catch (e) { return {}; } })();
  // braces matter here: without them the `else` binds to the inner `if` and a targeted
  // re-shoot wipes every other dish's credit entry
  if (only.length) {
    for (const [id, c] of Object.entries(credits)) if (!only.includes(id)) USED.add(c.title);
  } else {
    for (const k of Object.keys(credits)) delete credits[k];
  }
  let ok = 0, miss = [];
  for (const cat of CATEGORIES) {
    for (const item of cat.items) {
      if (only.length && !only.includes(item.id)) continue;
      process.stdout.write('  ' + item.id.padEnd(22));
      const hit = await pick(item.id, item.name, !!item.veg);
      if (!hit) { console.log('— no usable photo'); miss.push(item.id); continue; }
      fs.writeFileSync(path.join(OUT_DIR, item.id + '.jpg'), hit.buf);
      credits[item.id] = { dish: item.name, title: hit.title, artist: hit.artist, licence: hit.licence, source: hit.page };
      ok++;
      console.log("✓ " + (hit.tier === "quality" ? "Q " : "  ") + Math.round(hit.buf.length / 1024) + "KB  " + hit.title.slice(0, 44));
    }
  }
  fs.writeFileSync(CREDITS, JSON.stringify(credits, null, 2));
  console.log('\n' + ok + '/' + (ok + miss.length) + ' photos saved to public/img/menu');
  if (miss.length) console.log('missing: ' + miss.join(', '));
})();
