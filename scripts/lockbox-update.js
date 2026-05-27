'use strict';
// AppFolio lockbox bulk upsert.
//
// Modes:
//   node scripts/lockbox-update.js --probe       ← screenshot first form + dump field names
//   node scripts/lockbox-update.js --delete-all  ← delete every existing lockbox, then exit
//   node scripts/lockbox-update.js --dry-run     ← visit all forms, screenshot, no submit
//   node scripts/lockbox-update.js --retry       ← re-run only units that failed in last run
//   node scripts/lockbox-update.js               ← live run: create lockboxes for all units

const { chromium } = require('playwright');
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

const AF_HOST  = 'https://mckay.appfolio.com';
const DRY_RUN  = process.argv.includes('--dry-run') || process.argv.includes('--probe');
const PROBE    = process.argv.includes('--probe');
const DEL_ALL  = process.argv.includes('--delete-all');
const RETRY    = process.argv.includes('--retry');
const SS_DIR   = path.join(__dirname, '..', 'lockbox-screenshots');
fs.mkdirSync(SS_DIR, { recursive: true });

// ── REGION CODES ──────────────────────────────────────────────────────────────
// 1507 = Tri-Cities, Tacoma, Missoula, Helena  |  0517 = Spokane/Valley/Medical Lake
const UNIT_CODE_1507 = new Set([
  'kn47','ps17','ps25','ps91','rl16','rl21','tc34','tc68','ms43','ms22','hl65','hl73',
]);

// ── BUILDING ACCESS CODES ─────────────────────────────────────────────────────
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
    .replace(/\s+/g, '').replace(/[^a-z0-9-]/g, '');
  if (prop.startsWith('kn47')) prop = 'kn47';
  if (prop.startsWith('o155')) prop = 'o155';
  if (prop.startsWith('k104')) prop = 'k104';
  return `${prop}-${String(unitNum).replace(/\s+/g, '')}`;
}

// ── LOAD FULL UNIT LIST ───────────────────────────────────────────────────────
const unitsPath = path.join(__dirname, '..', 'data', 'units-all.json');
const ALL_UNITS = JSON.parse(fs.readFileSync(unitsPath, 'utf8').replace(/^﻿/, ''));
// units-all.json is an array of {unit_id, unit_name, property_name}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
async function login(page) {
  console.log('Opening AppFolio...');
  await page.goto(AF_HOST, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (page.url().startsWith('https://mckay.appfolio.com')) {
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    console.log('  Already logged in:', page.url());
    return;
  }
  // Auto-fill credentials are in the browser — just click the login button
  const loginBtn = page.locator('#kc-login, button:has-text("Sign in"), button:has-text("Log in"), input[type="submit"]').first();
  if (await loginBtn.count() > 0 && await loginBtn.isVisible().catch(() => false)) {
    console.log('  Auto-clicking login button...');
    await loginBtn.click({ timeout: 5000 }).catch(() => {});
  } else {
    console.log('  Waiting for manual login (click Log In in the browser)...');
  }
  await page.waitForURL(/^https:\/\/mckay\.appfolio\.com/, { timeout: 120000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  console.log('  Logged in:', page.url());
}

// ── PROBE ─────────────────────────────────────────────────────────────────────
async function probeForm(page, unitId, prop, unit) {
  const uname = encodeURIComponent(`${prop} - ${unit}`);
  const url   = `${AF_HOST}/manage_devices/lockboxes/new?unit_id=${unitId}&unit_name=${uname}`;
  console.log('\nPROBE navigating to:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SS_DIR, 'probe-form.png'), fullPage: true });

  const fields = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input,select,textarea,button')).map(el => ({
      tag: el.tagName, type: el.type || '', name: el.name || '', id: el.id || '',
      value: el.value || '', text: el.textContent?.trim().slice(0,40) || '',
      visible: el.offsetParent !== null,
    }))
  );
  console.log('\n── All interactive elements ──');
  fields.forEach(f => console.log(JSON.stringify(f)));
}

// ── DELETE ALL LOCKBOXES ──────────────────────────────────────────────────────
async function deleteAllLockboxes(page) {
  console.log('\nLoading lockboxes list at /manage_devices...');
  await page.goto(`${AF_HOST}/manage_devices`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  let deleted = 0, stuckCount = 0, lastRowName = null;
  const permanentSkip = new Set();

  while (true) {
    if (deleted > 2000) { console.log('  Safety stop (2000).'); break; }

    // Reload page every 50 deletions to keep DOM clean
    if (deleted > 0 && deleted % 50 === 0) {
      await page.goto(`${AF_HOST}/manage_devices`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2500);
      stuckCount = 0; lastRowName = null;
    }

    const mainRows = page.locator('tbody tr').filter({ has: page.locator('button') });
    const count    = await mainRows.count();
    if (count === 0) { console.log('  No more lockboxes.'); break; }

    const firstRow = mainRows.first();
    const lbName   = (await firstRow.locator('td').first().textContent().catch(() => '?')).trim();

    // Detect stuck: same row appearing repeatedly → reload, then permanently skip
    if (lbName === lastRowName) {
      stuckCount++;
      if (stuckCount === 4) {
        console.log(`  Stuck on "${lbName}" — reloading page...`);
        await page.goto(`${AF_HOST}/manage_devices`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2500);
        stuckCount = 0;
        continue;
      }
      if (stuckCount >= 8) {
        console.log(`  Permanently skipping "${lbName}" (not deletable)`);
        permanentSkip.add(lbName);
        stuckCount = 0; lastRowName = null;
        continue;
      }
    } else {
      stuckCount = 0;
      lastRowName = lbName;
    }

    // Skip rows flagged as permanently un-deletable
    if (permanentSkip.has(lbName)) {
      // Scroll past / find next row — just reload to get fresh list without this row at top
      // We need to move past it; click its toggle to collapse if expanded, then the NEXT row becomes first
      const toggle = firstRow.locator('button').last();
      await toggle.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
      continue;
    }

    // If Delete already visible (row pre-expanded), skip the toggle click
    const delLink   = page.locator('tbody a:has-text("Delete"), tbody button:has-text("Delete")').first();
    let   delVisible = await delLink.isVisible().catch(() => false);

    if (!delVisible) {
      const toggle = firstRow.locator('button').last();
      await toggle.click({ timeout: 5000 });
      // Wait for Delete to appear rather than a fixed timeout
      await delLink.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      delVisible = await delLink.isVisible().catch(() => false);
    }

    if (deleted === 0) {
      await page.screenshot({ path: path.join(SS_DIR, 'delete-dropdown.png') });
      console.log('  Screenshot → lockbox-screenshots/delete-dropdown.png');
    }

    if (!delVisible) {
      await page.screenshot({ path: path.join(SS_DIR, `no-delete-${deleted}-${stuckCount}.png`) });
      console.log(`  ? Delete not visible for "${lbName}" (stuck=${stuckCount})`);
      continue;
    }

    // AppFolio uses window.confirm() — accept before the click triggers it
    page.once('dialog', dialog => dialog.accept());
    await delLink.click({ timeout: 5000 });
    await page.waitForTimeout(2000);

    deleted++;
    lastRowName = null; // reset after successful deletion
    process.stdout.write(`  ✗  ${lbName} (${deleted})\n`);
  }

  console.log(`\n── Delete done: ${deleted} deleted`);
}

// ── DELETE LOCKBOX FOR A SPECIFIC UNIT ───────────────────────────────────────
async function deleteUnitLockbox(page, unitId, unitName, propName) {
  await page.goto(`${AF_HOST}/manage_devices`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  // Try matching by unit ID in href first, fall back to unit name text in td
  let unitRow = page.locator('tbody tr').filter({
    has: page.locator(`a[href*="/${unitId}"]`)
  }).first();

  if ((await unitRow.count()) === 0) {
    // Fallback: scan rows matching by lockbox name (first td) or unit column text (second td)
    const expectedName = lockboxName(propName, unitName).toLowerCase();
    const allRows      = page.locator('tbody tr').filter({ has: page.locator('button') });
    const count        = await allRows.count();
    for (let i = 0; i < count; i++) {
      const row      = allRows.nth(i);
      const nameCell = (await row.locator('td').first().textContent().catch(() => '')).toLowerCase().trim();
      const unitCell = (await row.locator('td').nth(1).textContent().catch(() => '')).toLowerCase();
      const nameMatch = nameCell === expectedName || nameCell.includes(expectedName);
      const unitMatch = unitCell.includes(String(unitName).toLowerCase()) &&
                        unitCell.includes(propName.split(/[\s-]/)[0].toLowerCase());
      if (nameMatch || unitMatch) { unitRow = row; break; }
    }
  }

  if ((await unitRow.count()) === 0) return false;

  const lbName = (await unitRow.locator('td').first().textContent().catch(() => '?')).trim();

  // Check if Delete already visible (row pre-expanded)
  const delLink = page.locator('tbody a:has-text("Delete"), tbody button:has-text("Delete")').first();
  if (!(await delLink.isVisible().catch(() => false))) {
    await unitRow.locator('button').last().click({ timeout: 5000 });
    await delLink.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  }

  if (!(await delLink.isVisible().catch(() => false))) return false;

  page.once('dialog', d => d.accept());
  await delLink.click({ timeout: 5000 });
  await page.waitForTimeout(2000);
  console.log(`  ✗  deleted existing lockbox "${lbName}" for unit ${unitId}`);
  return true;
}

// ── CREATE LOCKBOX ────────────────────────────────────────────────────────────
async function createLockbox(page, unitId, prop, unit) {
  const name  = lockboxName(prop, unit);
  const code  = unlockCode(prop);
  const uname = encodeURIComponent(`${prop} - ${unit}`);
  const url   = `${AF_HOST}/manage_devices/lockboxes/new?unit_id=${unitId}&unit_name=${uname}`;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.locator('[name="name"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);

  // Fill name
  const nameSelectors = ['[name="name"]', '[name="lockbox[name]"]', '#lockbox_name'];
  for (const sel of nameSelectors) {
    const el = page.locator(sel).first();
    if (await el.count() > 0 && await el.isVisible()) { await el.fill(name); break; }
  }

  // Fill unlock code
  const codeSelectors = [
    '[name="unlockCode"]', '[name="lockbox[combination]"]', '[name="lockbox[unlock_code]"]',
    '[name="lockbox[code]"]', '#lockbox_combination', '#lockbox_unlock_code',
  ];
  for (const sel of codeSelectors) {
    const el = page.locator(sel).first();
    if (await el.count() > 0 && await el.isVisible()) { await el.fill(code); break; }
  }

  if (DRY_RUN) {
    await page.screenshot({ path: path.join(SS_DIR, `${name}.png`) });
    console.log(`  [DRY] ${name.padEnd(24)} ${code}`);
    return 'dry_run';
  }

  await page.locator('button:has-text("Save")').click({ timeout: 8000 });
  await page.waitForTimeout(2000);

  // If URL changed away from /new the save succeeded — check errors only if still on /new
  const urlChanged = !page.url().includes('/new');
  if (urlChanged) return 'ok';

  const errMsg = await page.locator(
    '.flash-error,.alert-danger'
  ).first().textContent().catch(() => '');
  if (errMsg && errMsg.trim()) {
    await page.screenshot({ path: path.join(SS_DIR, `ERR-${name}.png`) });
    return `error: ${errMsg.trim().slice(0, 80)}`;
  }

  const hasSuccess  = (await page.locator(
    '.flash-success,.notice,.alert-success,.toast-success,[class*="success"],[class*="notice"]'
  ).count()) > 0;
  const nameCleared = (await page.locator('[name="name"]').inputValue().catch(() => '')) === '';
  return (hasSuccess || nameCleared) ? 'ok' : 'check';
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  // Persistent context saves login cookies to disk — only need to log in once
  const sessionDir = path.join(__dirname, '..', '.browser-session');
  const context    = await chromium.launchPersistentContext(sessionDir, { headless: false, slowMo: 60 });
  const page       = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(15000);

  try {
    await login(page);

    // ── PROBE mode ──────────────────────────────────────────────────────────
    if (PROBE) {
      // Also check the manage_devices index for lockbox list structure
      console.log('\nProbing /manage_devices index...');
      await page.goto(`${AF_HOST}/manage_devices`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(SS_DIR, 'probe-manage-devices.png'), fullPage: true });
      const mdLinks = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="lockbox"]')).map(a => ({
          text: a.textContent.trim().slice(0,60), href: a.getAttribute('href')
        }))
      );
      console.log('Lockbox links on /manage_devices:', JSON.stringify(mdLinks));

      const first = ALL_UNITS[0];
      console.log(`\nProbing lockbox form for ${first.property_name} / ${first.unit_name} (id=${first.unit_id})`);
      await probeForm(page, first.unit_id, first.property_name, first.unit_name);
      return;
    }

    // ── DELETE-ALL mode ──────────────────────────────────────────────────────
    if (DEL_ALL) {
      await deleteAllLockboxes(page);
      return;
    }

    // ── RETRY mode ──────────────────────────────────────────────────────────
    if (RETRY) {
      const resultsPath = path.join(__dirname, '..', 'lockbox-results.json');
      const prev        = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
      const failed      = prev.filter(r => r.status !== 'ok');
      console.log(`\nRetrying ${failed.length} failed units...`);
      const results = [];
      for (const { unit_id, property, unit } of failed) {
        try {
          await deleteUnitLockbox(page, unit_id, unit, property);
          const status = await createLockbox(page, unit_id, property, unit);
          const icon   = status === 'ok' ? '✓' : '✗';
          console.log(`  ${icon}  ${lockboxName(property, unit).padEnd(26)} ${unlockCode(property)}`);
          results.push({ unit_id, property, unit,
                         name: lockboxName(property, unit),
                         code: unlockCode(property), status });
        } catch(e) {
          console.error(`  ERR  ${property} ${unit}:`, e.message.slice(0, 80));
          results.push({ unit_id, property, unit,
                         name: lockboxName(property, unit), status: 'error', error: e.message });
        }
        await page.waitForTimeout(300);
      }
      const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
      console.log('\n── Retry done:', JSON.stringify(counts));
      // Merge back into results file
      const merged = prev.map(r => {
        const fix = results.find(x => x.unit_id === r.unit_id);
        return fix || r;
      });
      fs.writeFileSync(resultsPath, JSON.stringify(merged, null, 2));
      return;
    }

    // ── CREATE mode (default) ────────────────────────────────────────────────
    console.log(`\nCreating lockboxes for ${ALL_UNITS.length} units...`);
    const results = [];
    for (const { unit_id, unit_name, property_name } of ALL_UNITS) {
      try {
        const status = await createLockbox(page, unit_id, property_name, unit_name);
        const icon = status === 'ok' ? '✓' : status === 'dry_run' ? '·' : status === 'check' ? '?' : '✗';
        console.log(`  ${icon}  ${lockboxName(property_name, unit_name).padEnd(26)} ${unlockCode(property_name)}`);
        results.push({ unit_id, property: property_name, unit: unit_name,
                       name: lockboxName(property_name, unit_name),
                       code: unlockCode(property_name), status });
      } catch(e) {
        console.error(`  ERR  ${property_name} ${unit_name}:`, e.message.slice(0, 80));
        await page.screenshot({ path: path.join(SS_DIR, `ERR-${lockboxName(property_name, unit_name)}.png`) }).catch(() => {});
        results.push({ unit_id, property: property_name, unit: unit_name,
                       name: lockboxName(property_name, unit_name), status: 'error', error: e.message });
      }
      await page.waitForTimeout(300);
    }

    const counts = results.reduce((a, r) => {
      a[r.status] = (a[r.status] || 0) + 1; return a;
    }, {});
    console.log('\n── Done:', JSON.stringify(counts));
    fs.writeFileSync(path.join(__dirname, '..', 'lockbox-results.json'), JSON.stringify(results, null, 2));
    console.log('Results → lockbox-results.json');

  } finally {
    await context.close();
  }
})();
