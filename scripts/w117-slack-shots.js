// One-off: capture real screenshots of W117 pest-control Slack messages for a Google Doc.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SESSION_DIR = path.join(__dirname, '..', '.slack-browser-session');
const OUT_DIR = process.argv[2] || path.join(__dirname, '..', 'w117-shots');
fs.mkdirSync(OUT_DIR, { recursive: true });

const TARGETS = [
  { channel: 'C07ELE2DC3U', ts: 'p1779204088582039', name: '01_stefanie_initial_ask', scroll: 0 },
  { channel: 'C0B1QSDLT8C', ts: 'p1779204626539289', name: '02_forward_thread_top', scroll: 0 },
  { channel: 'C0B1QSDLT8C', ts: 'p1779204626539289', name: '03_forward_thread_cont', scroll: 500 },
  { channel: 'C0B65M2PXBM', ts: 'p1779843587940619', name: '04_city_ask', scroll: 0 },
  { channel: 'C0B7Y7PRCS1', ts: 'p1780500173774059', name: '05_pestcontrol_photo_policy', scroll: 0 },
  { channel: 'C0B7Y7PRCS1', ts: 'p1780500173774059', name: '06_pestcontrol_nte_schedule', scroll: 500 },
  { channel: 'C05TV4VNM7Y', ts: 'p1781215569838759', name: '07_maintenance_w117_7_status', scroll: 0 },
  { channel: 'C05TV4VNM7Y', ts: 'p1782750746226619', name: '08_maintenance_kyle_weber', scroll: 0 },
  { channel: 'D0AUUFPPM0V', ts: 'p1785170307187879', name: '09_florencia_july27', scroll: 0 },
];

function log(msg) { console.log(`[w117-shots] ${msg}`); }

async function waitForLogin(page) {
  log('Waiting for Slack sign-in (log in in the opened window)...');
  const deadline = Date.now() + 6 * 60 * 1000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/app\.slack\.com\/client/.test(url)) {
      log('Detected logged-in Slack session.');
      return;
    }
    await page.waitForTimeout(2000);
  }
  throw new Error('Timed out waiting for Slack login');
}

(async () => {
  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(20000);

  await page.goto('https://m5c7workspace.slack.com/messages/' + TARGETS[0].channel + '/' + TARGETS[0].ts, { waitUntil: 'domcontentloaded' });

  if (!/app\.slack\.com\/client/.test(page.url())) {
    await waitForLogin(page);
  }

  const results = [];
  for (const t of TARGETS) {
    const url = 'https://m5c7workspace.slack.com/messages/' + t.channel + '/' + t.ts;
    log(`Navigating: ${t.name} -> ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    if (t.scroll) {
      await page.mouse.wheel(0, t.scroll);
      await page.waitForTimeout(600);
    }
    const outPath = path.join(OUT_DIR, `${t.name}.png`);
    await page.screenshot({ path: outPath });
    results.push({ name: t.name, path: outPath });
    log(`Saved ${outPath}`);
  }

  await context.close();
  console.log('RESULT_JSON:' + JSON.stringify(results));
})().catch((err) => {
  console.error('[w117-shots] ERROR', err);
  process.exit(1);
});
