// One-off visual verification of the edit-while-placed feature.
// Drives the REAL customer + manager UIs in headless Chrome and saves screenshots.
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const BASE = "http://localhost:3000";
const OUT = path.join(__dirname, "..", "shots");
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const db = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "db.json"), "utf8"));
const r = db.restaurants["anand-palace"];
const table = r.tables[3]; // Table 4 (fresh)
const mgrJwt = process.argv[2];
if (!mgrJwt) throw new Error("pass the mgr JWT as argv[2]");

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--window-size=440,900"]
  });

  // Isolated browser contexts so manager and guest DON'T share cookies —
  // exactly like two separate devices in the restaurant.
  const mgrCtx = await browser.createBrowserContext();
  const custCtx = await browser.createBrowserContext();

  // ---- Manager dashboard (inject JWT cookie, skip the login UI) ----
  const mgr = await mgrCtx.newPage();
  await mgr.setViewport({ width: 1200, height: 900 });
  await mgr.setCookie({ name: "mgr", value: mgrJwt, domain: "localhost", path: "/" });

  // ---- Customer: seat via the real QR URL (sets signed cookies naturally) ----
  const cust = await custCtx.newPage();
  await cust.setViewport({ width: 420, height: 880, isMobile: true, hasTouch: true });
  await cust.goto(`${BASE}/r/anand-palace/table/${table.id}?t=${table.token}`, { waitUntil: "networkidle2" });
  await cust.waitForSelector(".dish-card", { timeout: 8000 });

  const clickJs = (page, sel) => page.$eval(sel, (el) => el.click());

  // Add the first dish, then place the order. (DOM clicks bypass CSS-animation
  // "not clickable" flakiness on freshly-rendered cards.)
  await clickJs(cust, ".dish-card .btn-add");
  await sleep(400);
  await cust.waitForSelector(".cart-bar.visible");
  await clickJs(cust, "#cart-bar");              // open the review sheet
  await cust.waitForSelector("[data-place]");
  await clickJs(cust, "[data-place]");           // place order
  await sleep(700);

  // Reopen the tracker — it should now show the editable block.
  await cust.waitForSelector(".edit-banner", { timeout: 5000 });
  await cust.screenshot({ path: path.join(OUT, "1-customer-edit-ui.png") });
  console.log("saved 1-customer-edit-ui.png  (edit banner present:",
    (await cust.$(".edit-banner")) ? "YES" : "NO", ")");

  // Open the manager board now that the order is placed.
  await mgr.goto(`${BASE}/manager`, { waitUntil: "networkidle2" });
  await mgr.waitForSelector(".order-card", { timeout: 8000 });
  await sleep(500);
  await mgr.screenshot({ path: path.join(OUT, "2-manager-before-edit.png") });

  // ---- The actual feature: edit quantity AFTER placing ----
  // Click the "+" (2nd qty button in the first edit row) twice.
  const clickPlus = () => cust.evaluate(() => {
    const btns = document.querySelectorAll(".edit-items .cart-item-row .modal-qty-btn");
    if (btns[1]) btns[1].click();
  });
  await clickPlus(); await sleep(400);
  await clickPlus(); await sleep(1000); // let the socket + dashboard react

  await cust.screenshot({ path: path.join(OUT, "3-customer-after-edit.png") });

  // Manager should show the edited badge + (transient) flash + toast.
  await sleep(300);
  await mgr.screenshot({ path: path.join(OUT, "4-manager-after-edit.png") });
  const edited = await mgr.$(".oc-edited");
  const flashMsg = await mgr.$eval("#mgr-flash", (el) => el.textContent).catch(() => "(none)");
  console.log("manager edited badge:", edited ? "YES" : "NO", "| flash:", flashMsg);

  await browser.close();
  console.log("done.");
})().catch((e) => { console.error("VERIFY FAILED:", e.message); process.exit(1); });
