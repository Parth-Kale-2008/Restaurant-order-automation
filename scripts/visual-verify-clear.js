// Visual check of the "Clear board" + "Cleared" history feature.
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const BASE = "http://localhost:3000";
const OUT = path.join(__dirname, "..", "shots");
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const db = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "db.json"), "utf8"));
const r = db.restaurants["anand-palace"];
const table = r.tables[5]; // Table 6
const mgrJwt = process.argv[2];
if (!mgrJwt) throw new Error("pass the mgr JWT as argv[2]");
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  const mgrCtx = await browser.createBrowserContext();
  const custCtx = await browser.createBrowserContext();

  // Place one fresh order so the board isn't empty.
  const cust = await custCtx.newPage();
  await cust.setViewport({ width: 420, height: 880 });
  await cust.goto(`${BASE}/r/anand-palace/table/${table.id}?t=${table.token}`, { waitUntil: "networkidle2" });
  await cust.waitForSelector(".dish-card");
  await cust.$eval(".dish-card .btn-add", (el) => el.click());
  await sleep(300);
  await cust.$eval("#cart-bar", (el) => el.click());
  await cust.waitForSelector("[data-place]");
  await cust.$eval("[data-place]", (el) => el.click());
  await sleep(600);

  const mgr = await mgrCtx.newPage();
  await mgr.setViewport({ width: 1200, height: 900 });
  await mgr.setCookie({ name: "mgr", value: mgrJwt, domain: "localhost", path: "/" });
  mgr.on("dialog", (d) => d.accept()); // auto-accept the confirm()
  await mgr.goto(`${BASE}/manager`, { waitUntil: "networkidle2" });
  await mgr.waitForSelector(".orders-toolbar");
  await sleep(400);
  await mgr.screenshot({ path: path.join(OUT, "clear-1-board-with-button.png") });
  console.log("toolbar present:", !!(await mgr.$("#clearBoardBtn")));

  // Click Clear board (dialog auto-accepted).
  await mgr.$eval("#clearBoardBtn", (el) => el.click());
  await sleep(900);
  await mgr.screenshot({ path: path.join(OUT, "clear-2-after-clear.png") });
  const liveCount = await mgr.$$eval(".order-card", (c) => c.length);
  console.log("live cards after clear:", liveCount);

  // Open Cleared view.
  await mgr.$eval("#viewClearedBtn", (el) => el.click());
  await sleep(800);
  await mgr.waitForSelector("#backLiveBtn");
  await mgr.screenshot({ path: path.join(OUT, "clear-3-cleared-view.png") });
  const archivedCount = await mgr.$$eval(".order-card", (c) => c.length);
  console.log("archived cards in cleared view:", archivedCount);

  await browser.close();
  console.log("done.");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
