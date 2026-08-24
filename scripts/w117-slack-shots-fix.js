const { chromium } = require('playwright');
const path = require('path');

const SESSION_DIR = path.join(__dirname, '..', '.slack-browser-session');
const OUT_DIR = process.argv[2];

const TARGETS = [
  { channel: 'C07ELE2DC3U', ts: 'p1779204088582039', name: '01_stefanie_initial_ask', scroll: 0 },
  { channel: 'C0B1QSDLT8C', ts: 'p1779204626539289', name: '02_forward_thread_top', scroll: 0 },
];

(async () => {
  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(20000);

  // warm up: load the workspace home first and let it fully settle
  await page.goto('https://m5c7workspace.slack.com/messages/' + TARGETS[0].channel + '/' + TARGETS[0].ts, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  for (const t of TARGETS) {
    const url = 'https://m5c7workspace.slack.com/messages/' + t.channel + '/' + t.ts;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.screenshot({ path: path.join(OUT_DIR, `${t.name}.png`) });
    console.log('Saved', t.name);
  }
  await context.close();
})().catch((err) => { console.error(err); process.exit(1); });
