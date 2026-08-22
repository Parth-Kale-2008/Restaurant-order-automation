# 🏰 Anand Palace — QR Table Ordering System

A complete fullstack restaurant ordering website. Guests **scan the QR code on their
table**, browse an animated menu, place an order, and watch its live status — while the
**reception/manager dashboard** sees every table's order update in real time.

Each guest can **only see and change their own order**, never anyone else's, and the
manager area is **password protected**.

---

## ✨ Features

**Guest (phone)**
- Scan table QR → instantly seated, no app or login needed
- 5 animated menu sections — each category enters with its own signature animation
  (Starters *bounce*, Mains *float/steam*, Breads *flip/toss*, Rice & Biryani *spin*,
  Chinese *noodles wave & dance*)
- Add / change quantities, see a running total, place the order
- **Live order tracker**: Placed → Preparing → Ready → Served (updates the instant the
  kitchen does)
- **Pay from your phone → instant bill**: choose UPI / Card / Cash and get a beautiful,
  itemised GST receipt (invoice number, CGST + SGST, PAID stamp) you can download / print
- Polished, dynamic UI — animated mesh background, 3D tilt cards, fly-to-cart, confetti
- Your order is private to your device — other guests at the same table can't see it

**Manager / Reception (desktop)**
- Password-protected dashboard
- **Live order board** — every table's order appears and updates instantly (websockets)
- Advance each order: Start preparing → Ready → Served → Paid (or Cancel)
- Live stats: active orders, tables seated, pending revenue, collected today
- **Tables & QR**: generate, view, and print a QR code for every table; change the
  number of tables anytime

**Security / correctness**
- Orders are bound to a signed `sid` cookie — the server only ever returns or edits the
  order belonging to the caller (verified end-to-end in tests)
- Prices are always taken from the server's menu — a tampered client price is ignored
- Manager routes require a signed JWT session; websocket rooms are authenticated too

---

## 🚀 Run it

> Requires [Node.js](https://nodejs.org) 18+ (tested on Node 24).

```powershell
cd anand-palace
npm install
npm start
```

Then open:

- **Reception dashboard:** http://localhost:3000/manager
- **Landing page:** http://localhost:3000
- **A guest view (demo):** http://localhost:3000/table/1

Default manager password: **`anand123`**

---

## 📱 Using it with real phones (same Wi-Fi)

QR codes must point at your computer's Wi-Fi address (not `localhost`) so phones can reach
it. When the server starts it prints that address, e.g.:

```
For phones on the same Wi-Fi, open the dashboard from:
  http://192.168.0.10:3000/manager
```

1. On your computer, open the dashboard at that **`http://192.168.x.x:3000/manager`** URL.
2. Go to **Tables & QR**, set your number of tables, and **Print** the QR codes — they
   will encode that Wi-Fi address automatically.
3. Place one QR on each table. Guests scan with their phone camera and start ordering.

(If Windows Firewall asks, allow Node.js on private networks so phones can connect.)

---

## ⚙️ Configuration (optional)

Set environment variables before `npm start`:

| Variable           | Default     | Purpose                          |
| ------------------ | ----------- | -------------------------------- |
| `PORT`             | `3000`      | Port to run on                   |
| `MANAGER_PASSWORD` | `anand123`  | Manager dashboard password       |
| `JWT_SECRET`       | random      | Manager session signing secret   |
| `COOKIE_SECRET`    | random      | Guest cookie signing secret      |

PowerShell example:

```powershell
$env:MANAGER_PASSWORD="my-secret"; npm start
```

> For a permanent deployment, set `JWT_SECRET` and `COOKIE_SECRET` to fixed long random
> strings so sessions survive restarts.

---

## 🗂️ Project structure

```
anand-palace/
├─ server.js            # Express + Socket.IO API, auth, QR, real-time
├─ lib/
│  ├─ menu.js           # The menu (single source of truth + per-category animations)
│  └─ store.js          # JSON-file datastore (data/db.json, auto-created)
├─ public/
│  ├─ index.html        # Landing page
│  ├─ table.html        # Guest ordering app (loaded at /table/:id)
│  ├─ manager.html      # Reception dashboard
│  ├─ css/style.css     # Guest UI + all category animations
│  ├─ css/manager.css   # Dashboard UI
│  └─ js/customer.js, js/manager.js
└─ data/db.json         # Tables + orders (created at runtime)
```

To reset all orders/tables, just delete `data/db.json` and restart.

---

## 🍽️ Editing the menu

Open `lib/menu.js` — each category has a `theme` (colours), an `anim` (its signature
animation: `bounce` · `float` · `flip` · `spin` · `wave`), and a list of dishes with
`name`, `price`, `emoji`, and `veg: true/false`. Change prices or dishes there and restart;
both the guest app and the dashboard update automatically.
