'use strict';
// Bulk-create AppFolio lockboxes for vacant units.
//
// Setup (one time):
//   npm install
//   npx playwright install chromium
//   copy .env.lockbox.example .env.lockbox   ← fill in your credentials
//
// Run:
//   node scripts/lockbox-update.js --probe      ← screenshot first form + dump field names, then exit
//   node scripts/lockbox-update.js --dry-run    ← navigate all forms, screenshot, no submit
//   node scripts/lockbox-update.js              ← live run

const { chromium } = require('playwright');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');

// ── ENV ──────────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env.lockbox');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.+)/);
    if (m) process.env[m[1]] = m[2].trim();
  });
}

const AF_HOST     = 'https://mckay.appfolio.com';
const AF_USERNAME = process.env.AF_USERNAME;    // API basic-auth user
const AF_PASSWORD = process.env.AF_PASSWORD;    // API basic-auth password
const AF_EMAIL    = process.env.AF_EMAIL;       // web login email
const AF_WEB_PASS = process.env.AF_WEB_PASSWORD;// web login password
const DRY_RUN     = process.argv.includes('--dry-run') || process.argv.includes('--probe');
const PROBE       = process.argv.includes('--probe');
const SS_DIR      = path.join(__dirname, '..', 'lockbox-screenshots');
fs.mkdirSync(SS_DIR, { recursive: true });

// ── REGION / UNIT CODES ───────────────────────────────────────────────────────
// 1507 = Tri-Cities, Tacoma, Missoula, Helena  |  0517 = Spokane/Valley/Medical Lake
const UNIT_CODE_1507 = new Set([
  'kn47','ps17','ps25','ps91','rl16','rl21','tc34','tc68','ms43','ms22','hl65','hl73',
]);

// ── BUILDING ACCESS CODES (null = no building entry door) ────────────────────
const BUILDING_CODES = {
  a511: '4323', a916: '1916', b101: '2947', c313: '3141',
  m221: '7017', m405: '3829', m608: '8061', w226: '5443',
  w117: '5982', o155: '5091', tc34: '3401', rl16: '0704',
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
function propKey(name) {
  const s = (name || '').toLowerCase().replace(/[\s\-]+/g, '');
  if (s.startsWith('kn47'))  return 'kn47';
  if (s.startsWith('o155'))  return 'o155';
  if (s.startsWith('k104'))  return 'k104';
  const m = s.match(/^([a-z]+\d+)/);
  return m ? m[1] : s;
}

function unlockCode(propertyName) {
  const key      = propKey(propertyName);
  const unitCode = UNIT_CODE_1507.has(key) ? '1507' : '0517';
  const bldg     = BUILDING_CODES[key];
  return bldg ? `Building ${bldg} - Unit ${unitCode}` : `Unit ${unitCode}`;
}

function lockboxName(propertyName, unitNum) {
  let prop = (propertyName || '').toLowerCase()
    .replace(/\s+/g, '')           // remove spaces
    .replace(/[^a-z0-9-]/g, '');  // strip non-alphanumeric (except dash)
  if (prop.startsWith('o155')) prop = 'o155';
  if (prop.startsWith('k104')) prop = 'k104';
  return `${prop}-${String(unitNum).replace(/\s+/g, '')}`;
}

// ── UNIT LIST (deduplicated from spreadsheet) ─────────────────────────────────
const UNITS = [
  { property: 'a511',      unit: '102'     },
  { property: 'a916',      unit: '8'       },
  { property: 'b101',      unit: '3'       },
  { property: 'b101',      unit: '8'       },
  { property: 'c302',      unit: '1'       },
  { property: 'c302',      unit: '5'       },
  { property: 'c302',      unit: '6'       },
  { property: 'c302',      unit: '7'       },
  { property: 'c302',      unit: '8'       },
  { property: 'c313',      unit: '6'       },
  { property: 'c313',      unit: '12'      },
  { property: 'c313',      unit: '18'      },
  { property: 'c313',      unit: '21'      },
  { property: 'c313',      unit: '24'      },
  { property: 'c313',      unit: '26'      },
  { property: 'c313',      unit: '27'      },
  { property: 'c313',      unit: '30'      },
  { property: 'c313',      unit: '33'      },
  { property: 'e328',      unit: '1'       },
  { property: 'e328',      unit: '4'       },
  { property: 'h731',      unit: '737B'    },
  { property: 'j312',      unit: '3104'    },
  { property: 'k104- LeFevre', unit: '101-1'  },
  { property: 'k104- LeFevre', unit: '107-7'  },
  { property: 'k104- LeFevre', unit: '314-12' },
  { property: 'k104- LeFevre', unit: '506-3'  },
  { property: 'k104- LeFevre', unit: '519-104'},
  { property: 'kn47 K1',   unit: 'A103'   },
  { property: 'kn47 K1',   unit: 'A104'   },
  { property: 'kn47 K1',   unit: 'A201'   },
  { property: 'kn47 K1',   unit: 'B102'   },
  { property: 'kn47 K1',   unit: 'C109'   },
  { property: 'kn47 K1',   unit: 'D104'   },
  { property: 'kn47 K1',   unit: 'D107'   },
  { property: 'kn47 K1',   unit: 'D202'   },
  { property: 'kn47 K1',   unit: 'E204'   },
  { property: 'kn47 K1',   unit: 'E207'   },
  { property: 'kn47 K1',   unit: 'F202'   },
  { property: 'kn47 K1',   unit: 'H101'   },
  { property: 'kn47 K1',   unit: 'H105'   },
  { property: 'kn47 K1',   unit: 'H201'   },
  { property: 'kn47 K1',   unit: 'H202'   },
  { property: 'kn47 K1',   unit: 'H204'   },
  { property: 'kn47 K1',   unit: 'J101'   },
  { property: 'kn47 K1',   unit: 'J205'   },
  { property: 'kn47 K1',   unit: 'J207'   },
  { property: 'kn47 K1',   unit: 'L105'   },
  { property: 'kn47 K1',   unit: 'L203'   },
  { property: 'kn47 K1',   unit: 'M205'   },
  { property: 'kn47 K1',   unit: 'M206'   },
  { property: 'kn47 K2',   unit: 'A102'   },
  { property: 'kn47 K2',   unit: 'A205'   },
  { property: 'kn47 K2',   unit: 'B201'   },
  { property: 'kn47 K2',   unit: 'B205'   },
  { property: 'kn47 K2',   unit: 'D104'   },
  { property: 'kn47 K2',   unit: 'D108'   },
  { property: 'kn47-k3',   unit: 'K101'   },
  { property: 'm221',      unit: '2'       },
  { property: 'm221',      unit: '31'      },
  { property: 'm405',      unit: '24'      },
  { property: 'm405',      unit: '25'      },
  { property: 'm608',      unit: '2'       },
  { property: 'ms43',      unit: '444'     },
  { property: 'o155-Elm',  unit: 'J'       },
  { property: 'o155-Oak',  unit: 'B6'      },
  { property: 'o155-Oak',  unit: 'C9'      },
  { property: 'o155-Oak',  unit: 'D6'      },
  { property: 'p705',      unit: '3'       },
  { property: 'p705',      unit: '17'      },
  { property: 'ps17',      unit: 'A3'      },
  { property: 'ps17',      unit: 'A5'      },
  { property: 'ps17',      unit: 'A8'      },
  { property: 'ps17',      unit: 'A10'     },
  { property: 'ps17',      unit: 'B3'      },
  { property: 'ps17',      unit: 'B4'      },
  { property: 'ps25',      unit: 'A4'      },
  { property: 'ps25',      unit: 'A8'      },
  { property: 'ps25',      unit: 'B9'      },
  { property: 'ps25',      unit: 'B14'     },
  { property: 'ps25',      unit: 'C22'     },
  { property: 'ps25',      unit: 'D23'     },
  { property: 'ps25',      unit: 'E32'     },
  { property: 'ps25',      unit: 'F37'     },
  { property: 'ps25',      unit: 'F43'     },
  { property: 'ps91',      unit: '2'       },
  { property: 'ps91',      unit: '918'     },
  { property: 'rl16',      unit: 'A02'     },
  { property: 'rl16',      unit: 'A03'     },
  { property: 'rl16',      unit: 'A04'     },
  { property: 'rl16',      unit: 'A11'     },
  { property: 'rl16',      unit: 'A15'     },
  { property: 'rl16',      unit: 'A17'     },
  { property: 'rl16',      unit: 'A21'     },
  { property: 'rl16',      unit: 'B04'     },
  { property: 'rl16',      unit: 'B22'     },
  { property: 'rl16',      unit: 'C02'     },
  { property: 'rl16',      unit: 'C08'     },
  { property: 'rl16',      unit: 'C13'     },
  { property: 'rl16',      unit: 'C17'     },
  { property: 'rl16',      unit: 'D10'     },
  { property: 'rl16',      unit: 'D19'     },
  { property: 'rl21',      unit: '9'       },
  { property: 'rl21',      unit: '16'      },
  { property: 's129',      unit: '10'      },
  { property: 's300',      unit: '12'      },
  { property: 'tc34',      unit: 'A105'    },
  { property: 'tc34',      unit: 'A106'    },
  { property: 'tc34',      unit: 'B112'    },
  { property: 'tc68',      unit: 'A02'     },
  { property: 'tc68',      unit: 'A07'     },
  { property: 'tc68',      unit: 'A13'     },
  { property: 'tc68',      unit: 'A18'     },
  { property: 'tc68',      unit: 'A24'     },
  { property: 'tc68',      unit: 'A27'     },
  { property: 'tc68',      unit: 'A28'     },
  { property: 'tc68',      unit: 'A30'     },
  { property: 'tc68',      unit: 'B32'     },
  { property: 'tc68',      unit: 'B51'     },
  { property: 'tc68',      unit: 'B54'     },
  { property: 'tc68',      unit: 'C64'     },
  { property: 'tc68',      unit: 'C65'     },
  { property: 'tc68',      unit: 'C67'     },
  { property: 'tc68',      unit: 'C71'     },
  { property: 'tc68',      unit: 'C75'     },
  { property: 'tc68',      unit: 'C76'     },
  { property: 'tc68',      unit: 'D080'    },
  { property: 'tc68',      unit: 'D081'    },
  { property: 'tc68',      unit: 'D088'    },
  { property: 'tc68',      unit: 'D091'    },
  { property: 'v202',      unit: '1'       },
  { property: 'v202',      unit: '2'       },
  { property: 'v202',      unit: '6'       },
  { property: 'w117',      unit: '3'       },
  { property: 'w117',      unit: '10'      },
  { property: 'w226',      unit: '4'       },
  { property: 'w226',      unit: '5'       },
  { property: 'w226',      unit: '9'       },
];

// ── APPFOLIO API: UNIT DIRECTORY ──────────────────────────────────────────────
async function fetchUnitIds() {
  console.log('Fetching unit directory from AppFolio API...');
  return new Promise((resolve, reject) => {
    const auth = 'Basic ' + Buffer.from(`${AF_USERNAME}:${AF_PASSWORD}`).toString('base64');
    const body = JSON.stringify({ property_visibility: 'active' });
    const req  = https.request({
      hostname: 'mckay.appfolio.com', path: '/api/v2/reports/unit_directory.json', method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json',
                 'Content-Length': Buffer.byteLength(body), 'Accept': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Parse error: ' + d.slice(0, 300))); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function buildUnitLookup(data) {
  const rows = Array.isArray(data) ? data : (data.results || []);
  if (rows.length === 0) { console.warn('  Warning: unit directory returned 0 rows'); return {}; }

  // Print first row so we can see field names if probe
  if (PROBE) console.log('  Sample unit row fields:', Object.keys(rows[0]));

  const map = {};
  rows.forEach(r => {
    // AppFolio may use different field names — try common variants
    const prop   = (r.property_name || r.property || '').toLowerCase().trim();
    const unit   = (r.unit_name || r.unit || r.unit_number || '').toLowerCase().trim();
    const unitId = r.unit_id || r.id;
    if (prop && unit && unitId) map[`${prop}|${unit}`] = String(unitId);
  });
  console.log(`  Lookup built: ${Object.keys(map).length} units`);
  return map;
}

function findUnitId(lookup, propertyName, unitNum) {
  const unit = String(unitNum).toLowerCase().trim();
  // Try progressively looser property name matches
  const propVariants = [
    propertyName,
    propertyName.replace(/\s+k[123]$/i, '').trim(),      // "kn47 K1" → "kn47"
    propertyName.replace(/\s*-\s*/g, '-').trim(),         // "k104- LeFevre" → "k104-LeFevre"
    propertyName.split('-')[0].trim(),                     // "o155-Oak" → "o155"
    propertyName.split('-')[0].trim() + '-Oak',
    propertyName.split('-')[0].trim() + '-Elm',
  ];
  for (const p of propVariants) {
    const key = p.toLowerCase().trim() + '|' + unit;
    if (lookup[key]) return lookup[key];
  }
  return null;
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
async function login(page) {
  console.log('Logging in to AppFolio...');
  await page.goto(AF_HOST, { waitUntil: 'networkidle', timeout: 30000 });
  // Keycloak login page
  await page.waitForSelector('input[type="email"], input[name="username"], #username', { timeout: 15000 });
  await page.fill('input[type="email"], input[name="username"], #username', AF_EMAIL);
  const pwNow = await page.locator('input[type="password"]').isVisible().catch(() => false);
  if (!pwNow) {
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  }
  await page.fill('input[type="password"]', AF_WEB_PASS);
  await Promise.all([
    page.waitForNavigation({ timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
  console.log('  Logged in:', page.url());
}

// ── PROBE: dump form fields ───────────────────────────────────────────────────
async function probeForm(page, unitId, prop, unit) {
  const uname = encodeURIComponent(`${prop} - ${unit}`);
  const url   = `${AF_HOST}/manage_devices/lockboxes/new?unit_id=${unitId}&unit_name=${uname}`;
  console.log('\nPROBE navigating to:', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
  await page.screenshot({ path: path.join(SS_DIR, 'probe-form.png'), fullPage: true });
  console.log('Screenshot → lockbox-screenshots/probe-form.png');

  const fields = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input,select,textarea')).map(el => ({
      tag: el.tagName, type: el.type || '', name: el.name || '',
      id: el.id || '', placeholder: el.placeholder || '',
      label: document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() || '',
    }))
  );
  console.log('\n── Form fields ──');
  fields.forEach(f => console.log(JSON.stringify(f)));
}

// ── CREATE LOCKBOX ────────────────────────────────────────────────────────────
async function createLockbox(page, unitId, prop, unit) {
  const name = lockboxName(prop, unit);
  const code = unlockCode(prop);
  const uname = encodeURIComponent(`${prop} - ${unit}`);
  const url   = `${AF_HOST}/manage_devices/lockboxes/new?unit_id=${unitId}&unit_name=${uname}`;

  await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });

  // ── Fill name field ──────────────────────────────────────────────────────
  // Try the selectors most likely used by AppFolio — adjust after --probe if needed
  const nameSelectors = ['[name="lockbox[name]"]', '#lockbox_name', '[placeholder*="name" i]'];
  for (const sel of nameSelectors) {
    const el = page.locator(sel).first();
    if (await el.count() > 0 && await el.isVisible()) { await el.fill(name); break; }
  }

  // ── Fill unlock code / combination ──────────────────────────────────────
  const codeSelectors = [
    '[name="lockbox[combination]"]', '[name="lockbox[unlock_code]"]',
    '[name="lockbox[code]"]', '#lockbox_combination',
    '#lockbox_unlock_code', '[placeholder*="code" i]', '[placeholder*="combination" i]',
  ];
  for (const sel of codeSelectors) {
    const el = page.locator(sel).first();
    if (await el.count() > 0 && await el.isVisible()) { await el.fill(code); break; }
  }

  if (DRY_RUN) {
    await page.screenshot({ path: path.join(SS_DIR, `${name}.png`) });
    console.log(`  [DRY] ${name.padEnd(20)} ${code}`);
    return 'dry_run';
  }

  await page.click('button[type="submit"], input[type="submit"]');
  await page.waitForTimeout(1500);

  const success = !page.url().includes('/new') ||
    (await page.locator('.flash-success,.notice,.alert-success').count()) > 0;
  return success ? 'ok' : 'check';
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!AF_EMAIL || !AF_WEB_PASS) {
    console.error('Missing credentials in .env.lockbox — need AF_EMAIL and AF_WEB_PASSWORD at minimum.');
    process.exit(1);
  }

  // Step 1: get unit IDs via API
  let lookup = {};
  if (AF_USERNAME && AF_PASSWORD) {
    try { lookup = buildUnitLookup(await fetchUnitIds()); }
    catch(e) { console.warn('Unit directory fetch failed:', e.message, '\n  Will skip units with missing IDs.'); }
  } else {
    console.warn('AF_USERNAME / AF_PASSWORD not set — skipping API unit lookup.');
  }

  // Step 2: browser
  const browser = await chromium.launch({ headless: false, slowMo: 80 });
  const page    = await browser.newPage();
  page.setDefaultTimeout(15000);

  try {
    await login(page);

    if (PROBE) {
      const first  = UNITS[0];
      const unitId = findUnitId(lookup, first.property, first.unit);
      if (!unitId) console.log('Could not find unit_id for', first.property, first.unit, '— check lookup output above.');
      else         await probeForm(page, unitId, first.property, first.unit);
      await browser.close(); return;
    }

    const results = [];
    for (const { property, unit } of UNITS) {
      const unitId = findUnitId(lookup, property, unit);
      if (!unitId) {
        console.log(`  SKIP  ${lockboxName(property, unit).padEnd(22)} — unit_id not found`);
        results.push({ property, unit, name: lockboxName(property, unit), status: 'not_found' });
        continue;
      }
      try {
        const status = await createLockbox(page, unitId, property, unit);
        const icon = status === 'ok' ? '✓' : status === 'dry_run' ? '·' : '?';
        console.log(`  ${icon}  ${lockboxName(property, unit).padEnd(22)} ${unlockCode(property)}`);
        results.push({ property, unit, name: lockboxName(property, unit), code: unlockCode(property), status });
      } catch(e) {
        console.error(`  ERR  ${property} ${unit}:`, e.message);
        await page.screenshot({ path: path.join(SS_DIR, `ERR-${lockboxName(property, unit)}.png`) }).catch(()=>{});
        results.push({ property, unit, name: lockboxName(property, unit), status: 'error', error: e.message });
      }
      await page.waitForTimeout(400);
    }

    const ok   = results.filter(r => ['ok','dry_run'].includes(r.status)).length;
    const skip = results.filter(r => r.status === 'not_found').length;
    const err  = results.filter(r => r.status === 'error').length;
    console.log(`\n── ${DRY_RUN ? 'Dry run' : 'Done'}: ${ok} ${DRY_RUN?'previewed':'created'}, ${skip} skipped (no unit_id), ${err} errors`);

    const resultFile = path.join(__dirname, '..', 'lockbox-results.json');
    fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
    console.log('Results →', resultFile);

  } finally {
    await browser.close();
  }
})();
