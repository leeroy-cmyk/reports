const https = require('https');
const fs = require('fs');
const path = require('path');

const AF_HOST = 'mckay.appfolio.com';
const EXCLUDED_PROPERTIES = ['Easy Street']; // test properties
const AUTH = 'Basic ' + Buffer.from(
  process.env.AF_USERNAME + ':' + process.env.AF_PASSWORD
).toString('base64');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function fetchAF(apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = https.request({
      hostname: AF_HOST, path: apiPath, method: 'POST',
      headers: {
        'Authorization': AUTH,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Accept': 'application/json'
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error (' + res.statusCode + '): ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function save(name, obj) {
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(obj, null, 2));
  console.log('Saved data/' + name);
}

async function fetchTurnVac() {
  console.log('Fetching unit_vacancy...');
  const raw = await fetchAF('/api/v2/reports/unit_vacancy.json', {});
  const rows = (Array.isArray(raw) ? raw : (raw.results || [])).filter(r => !EXCLUDED_PROPERTIES.includes(r.property_name));
  save('turnvac.json', { ok: true, count: rows.length, fetched_at: new Date().toISOString(), rows });
}

// Rule A: detect move-out date changes / cancellations day-over-day (from turnvac).
function buildMoveoutChanges() {
  const tvPath = path.join(DATA_DIR, 'turnvac.json');
  if (!fs.existsSync(tvPath)) { console.log('buildMoveoutChanges: turnvac.json missing, skip.'); return; }
  const rows = JSON.parse(fs.readFileSync(tvPath, 'utf8')).rows || [];
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const cur = {};
  rows.forEach(r => { if (r.unit_id != null) cur[r.unit_id] = { moveOut: r.last_move_out || null, status: r.unit_status || '', prop: r.property_name, unit: r.unit, city: r.city }; });
  const statePath = path.join(DATA_DIR, 'moveout_state.json');
  let state = { units: {}, changes: [] };
  if (fs.existsSync(statePath)) { try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch(e) {} }
  const prev = state.units || {};
  const firstRun = Object.keys(prev).length === 0;
  const nc = [];
  if (!firstRun) {
    for (const id in cur) {
      if (prev[id] && prev[id].moveOut !== cur[id].moveOut)
        nc.push({ date: today, type: 'moveout_changed', unit_id: id, prop: cur[id].prop, unit: cur[id].unit, city: cur[id].city, from: prev[id].moveOut, to: cur[id].moveOut });
      if (!prev[id])
        nc.push({ date: today, type: 'moveout_new', unit_id: id, prop: cur[id].prop, unit: cur[id].unit, city: cur[id].city, to: cur[id].moveOut });
    }
    for (const id in prev) {
      if (!cur[id]) nc.push({ date: today, type: 'moveout_removed', unit_id: id, prop: prev[id].prop, unit: prev[id].unit, city: prev[id].city, from: prev[id].moveOut, was_status: prev[id].status });
    }
  }
  const cutoff = new Date(Date.now() - 60 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const changes = (state.changes || []).concat(nc).filter(c => c.date >= cutoff);
  save('moveout_state.json', { fetched_at: new Date().toISOString(), units: cur, changes });
  save('moveout_changes.json', { fetched_at: new Date().toISOString(), changes: changes.slice(-300) });
  console.log(`buildMoveoutChanges: ${firstRun ? 'seeded state (first run)' : nc.length + ' new change(s)'}`);
}

// ── VACANCY LEDGER (turn_ledger.json) ────────────────────────────────────────
// AppFolio's unit_vacancy report only returns units that are CURRENTLY vacant. The
// moment a unit re-rents it disappears, taking its move-out and rent-ready dates with
// it — so a turn completed earlier this month can lose the dates the weekly report
// needs. Measured 2026-08-10: only 16% of June completions were still in the snapshot,
// vs 67% of August's.
//
// This is an append-only ledger: every run records each vacant unit's move-out and the
// FIRST date we ever observed it rent-ready, keyed by unit_id, and never deletes. Once
// captured, a unit keeps its dates permanently. It only accumulates going forward —
// dates already lost to re-renting cannot be recovered.
function buildTurnLedger() {
  const tvPath = path.join(DATA_DIR, 'turnvac.json');
  if (!fs.existsSync(tvPath)) { console.log('buildTurnLedger: turnvac.json missing, skip.'); return; }
  const rows = JSON.parse(fs.readFileSync(tvPath, 'utf8')).rows || [];
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const p = path.join(DATA_DIR, 'turn_ledger.json');
  let led = { units: {} };
  if (fs.existsSync(p)) { try { led = JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) {} }
  const U = led.units || (led.units = {});
  let added = 0, readied = 0;

  for (const r of rows) {
    if (r.unit_id == null) continue;
    const k = String(r.unit_id);
    const e = U[k] || (U[k] = { prop: r.property_name, unit: r.unit, city: r.city, first_seen: today });
    added += e.first_seen === today ? 1 : 0;
    e.prop = r.property_name; e.unit = r.unit; e.city = r.city;
    // Move-out can legitimately be revised (Rule A tracks that); keep the latest value.
    if (r.last_move_out) e.move_out = r.last_move_out;
    // Rent-ready: record the first observation only, so a later re-turn of the same unit
    // cannot overwrite the date that belongs to the turn we are reporting on.
    const isReady = String(r.rent_ready || '').toLowerCase() === 'yes';
    if (isReady && !e.ready_date) {
      // Prefer AppFolio's own date over "the day we noticed", falling back to today.
      e.ready_date = r.ready_for_showing_on || r.available_on || today;
      e.ready_source = r.ready_for_showing_on ? 'ready_for_showing_on' : (r.available_on ? 'available_on' : 'observed');
      readied++;
    }
    e.last_seen = today;
  }
  save('turn_ledger.json', { fetched_at: new Date().toISOString(), units: U });
  console.log(`turn_ledger.json: ${Object.keys(U).length} units tracked (${added} new, ${readied} newly rent-ready)`);
}

// AppFolio's own Turn section (Maintenance → Unit Turns), one row per unit turn.
// `turn_end_date` is the date the unit turn is marked complete there — LeeRoy's
// definition of when a turn ended (2026-08-12), NOT the rent-ready/available date.
// The report also carries OPEN turns, with turn_end_date null, which is how a turn
// still in progress correctly resolves to a blank rather than a stale earlier date.
//
// The work_order report cannot substitute for this: it only returns OPEN work
// orders (verified 2026-08-12 — 0 rows with completed_on across every status
// filter the API accepts), so completed Unit Turn WOs are invisible to it.
async function fetchUnitTurnDetail() {
  console.log('Fetching unit_turn_detail...');
  const raw = await fetchAF('/api/v2/reports/unit_turn_detail.json', {});
  const rows = (Array.isArray(raw) ? raw : (raw.results || [])).filter(r => !EXCLUDED_PROPERTIES.includes(r.property));
  save('unit_turn_detail.json', { ok: true, count: rows.length, fetched_at: new Date().toISOString(), rows });
  console.log(`unit_turn_detail.json: ${rows.length} turns, ${rows.filter(r => r.turn_end_date).length} with a turn end date`);
}

async function fetchWorkOrders() {
  console.log('Fetching work_order...');
  const raw = await fetchAF('/api/v2/reports/work_order.json', { property_visibility: 'active' });
  const rows = (Array.isArray(raw) ? raw : (raw.results || raw.work_orders || [])).filter(r => !EXCLUDED_PROPERTIES.includes(r.property_name));
  save('workorders.json', { ok: true, count: rows.length, fetched_at: new Date().toISOString(), rows });
}

async function fetchBudget() {
  console.log('Fetching property directory...');
  const RM_CAPEX_ACCOUNTS = ['52001','52002','52003','80121','80122','80130','80140'];
  const today = new Date().toISOString().slice(0, 10);

  const propData = await fetchAF('/api/v2/reports/property_directory.json', { property_visibility: 'active' });
  const allProps = Array.isArray(propData) ? propData : (propData.results || []);
  const realProps = allProps.filter(p => p.property_id && p.property_city !== '*' && !EXCLUDED_PROPERTIES.includes(p.property_name));
  console.log('Fetching budget for ' + realProps.length + ' properties...');

  const portfolioRaw = await fetchAF('/api/v2/reports/annual_budget_comparative.json', {
    occurred_on_to: today, level_of_detail: 'detail_view',
    property_visibility: 'active', accounting_basis: 'Accrual'
  });

  const extractAccounts = (data) => {
    const rows = Array.isArray(data) ? data : (data.results || []);
    const out = {};
    rows.filter(r => RM_CAPEX_ACCOUNTS.includes(r.account_number)).forEach(r => { out[r.account_number] = r; });
    return out;
  };

  const properties = [];
  for (let i = 0; i < realProps.length; i++) {
    const p = realProps[i];
    try {
      const data = await fetchAF('/api/v2/reports/annual_budget_comparative.json', {
        occurred_on_to: today, level_of_detail: 'detail_view',
        property_visibility: 'active', accounting_basis: 'Accrual',
        properties: { properties_ids: [String(p.property_id)] }
      });
      properties.push({ property_id: p.property_id, property_name: p.property_name || p.name,
        property_address: p.property_address, city: p.property_city, state: p.property_state,
        units: p.units, accounts: extractAccounts(data) });
      process.stdout.write('  ' + (i+1) + '/' + realProps.length + '\r');
    } catch(e) {
      console.error('  Failed ' + (p.property_name||p.property_id) + ': ' + e.message);
      properties.push({ property_id: p.property_id, property_name: p.property_name, accounts: {} });
    }
    if (i < realProps.length - 1) await sleep(150);
  }

  save('budget.json', {
    ok: true, fetched_at: new Date().toISOString(),
    portfolio: extractAccounts(portfolioRaw), properties
  });
}

const QBT_TOKEN = process.env.QBT_TOKEN;
const QBT_HOST = 'rest.tsheets.com';

function fetchQBT(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: QBT_HOST, path: apiPath, method: 'GET',
      timeout: 30000,
      headers: { 'Authorization': 'Bearer ' + QBT_TOKEN, 'Accept': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('QBT parse error (' + res.statusCode + '): ' + data.slice(0, 200))); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('QBT request timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function fetchAllQBT(path, resultsKey) {
  let page = 1, all = {};
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetchQBT(path + sep + 'page=' + page + '&per_page=200');
    const chunk = (res.results && res.results[resultsKey]) || {};
    Object.assign(all, chunk);
    if (!res.more) break;
    page++;
    await sleep(100);
  }
  return all;
}

async function fetchQBTime() {
  if (!QBT_TOKEN) { console.log('QBT_TOKEN not set, skipping QBTime fetch.'); return; }
  console.log('Fetching QuickBooks Time data...');

  const [users, jobcodes, customfields] = await Promise.all([
    fetchAllQBT('/api/v1/users', 'users'),
    fetchAllQBT('/api/v1/jobcodes', 'jobcodes'),
    fetchAllQBT('/api/v1/customfields', 'customfields'),
  ]);

  // Fetch all custom field items
  const cfItems = {};
  for (const cfId of Object.keys(customfields)) {
    if (customfields[cfId].type === 'managed-list') {
      const items = await fetchAllQBT('/api/v1/customfielditems?customfield_id=' + cfId, 'customfielditems');
      cfItems[cfId] = items;
      await sleep(150);
    }
  }

  // Incremental timesheet fetch — merge with existing data like Ramp does
  const qbtPath = path.join(DATA_DIR, 'qbtime.json');
  let existing = {};
  if (fs.existsSync(qbtPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(qbtPath, 'utf8'));
      Object.assign(existing, prev.timesheets || {});
      console.log('QBTime: loaded ' + Object.keys(existing).length + ' existing timesheets');
    } catch(e) { console.log('QBTime: starting fresh'); }
  }

  // First run: 180-day lookback; subsequent: 14-day overlap to catch edits
  const hasExisting = Object.keys(existing).length > 0;
  const lookbackDays = hasExisting ? 14 : 180;
  const endDate   = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
  console.log('QBTime: fetching timesheets ' + startDate + ' to ' + endDate + ' (' + lookbackDays + '-day window)...');

  const fresh = await fetchAllQBT(
    '/api/v1/timesheets?start_date=' + startDate + '&end_date=' + endDate + '&on_the_clock=no',
    'timesheets'
  );
  Object.assign(existing, fresh);

  save('qbtime.json', {
    ok: true, fetched_at: new Date().toISOString(),
    users, jobcodes, customfields, cfItems, timesheets: existing
  });
  console.log('QBTime: saved ' + Object.keys(existing).length + ' timesheets (' + Object.keys(fresh).length + ' refreshed)');
}

const RAMP_CLIENT_ID     = process.env.RAMP_CLIENT_ID;
const RAMP_CLIENT_SECRET = process.env.RAMP_CLIENT_SECRET;

function fetchRampToken(scope = 'transactions:read') {
  return new Promise((resolve, reject) => {
    const body = 'grant_type=client_credentials&scope=' + encodeURIComponent(scope);
    const auth = Buffer.from(RAMP_CLIENT_ID + ':' + RAMP_CLIENT_SECRET).toString('base64');
    const req = https.request({
      hostname: 'api.ramp.com', path: '/developer/v1/token', method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d).access_token); }
        catch(e) { reject(new Error('Ramp token error: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function fetchRamp(token, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.ramp.com', path, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Ramp parse error (' + res.statusCode + '): ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject); req.end();
  });
}

async function fetchRampTransactions() {
  if (!RAMP_CLIENT_ID || !RAMP_CLIENT_SECRET) { console.log('Ramp credentials not set, skipping.'); return; }
  console.log('Fetching Ramp transactions...');
  const token = await fetchRampToken();

  // Load existing data to merge — keeps all historical records
  const rampPath = path.join(DATA_DIR, 'ramp.json');
  let existing = {};
  if (fs.existsSync(rampPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(rampPath, 'utf8'));
      (prev.transactions || []).forEach(t => { existing[t.id] = t; });
      console.log('  Loaded ' + Object.keys(existing).length + ' existing transactions');
    } catch(e) { console.log('  Could not load existing ramp.json, starting fresh'); }
  }

  // On first run fetch 5 months; on subsequent runs use 60-day window so recently-tagged
  // WO codes on older transactions (added in Ramp after the transaction date) get picked up.
  const hasExisting = Object.keys(existing).length > 0;
  const lookbackDays = hasExisting ? 60 : 150;
  const fromTime = new Date(Date.now() - lookbackDays * 86400000).toISOString();

  let newCount = 0, nextPage = null, page = 1;
  while (true) {
    const qs = new URLSearchParams({ limit: '100', from_time: fromTime });
    if (nextPage) qs.set('start', nextPage);
    const res = await fetchRamp(token, '/developer/v1/transactions?' + qs.toString());
    (res.data || []).forEach(t => { existing[t.id] = t; newCount++; });
    process.stdout.write('  page ' + page + ' (+' + newCount + ' new)\r');
    if (!res.page || !res.page.next) break;
    const nextUrl = new URL(res.page.next);
    nextPage = nextUrl.searchParams.get('start');
    page++;
    await sleep(100);
  }

  const transactions = Object.values(existing).sort((a,b) => a.user_transaction_time < b.user_transaction_time ? 1 : -1);
  console.log('\nRamp: ' + transactions.length + ' total transactions (' + newCount + ' new/updated)');
  save('ramp.json', { ok: true, fetched_at: new Date().toISOString(), transactions });
}

function buildAuditData() {
  const qbtPath = path.join(DATA_DIR, 'qbtime.json');
  if (!fs.existsSync(qbtPath)) { console.log('buildAuditData: qbtime.json not found, skipping.'); return; }
  console.log('Building audit.json...');
  const { users, jobcodes, timesheets, fetched_at } = JSON.parse(fs.readFileSync(qbtPath, 'utf8'));

  function getPath(id) {
    const j = jobcodes[id];
    if (!j) return [];
    if (j.parent_id === 0) return [j.name];
    return [...getPath(j.parent_id), j.name];
  }

  const entries = Object.values(timesheets)
    .filter(t => t.type === 'regular')
    .map(t => {
      const u = users[t.user_id];
      const name = u ? u.first_name + ' ' + u.last_name : 'User ' + t.user_id;
      const cls  = t.customfields['25056'] || '';
      const prop = t.customfields['25068'] || '';
      const p    = getPath(t.jobcode_id);
      const isOpex    = cls === 'r203';
      const isGrounds = /grounds/i.test(cls);
      const hasSpecificProp = prop.trim() && prop !== 'r203';
      const issues = [];
      if (t.duration > 7200)                                     issues.push('long');
      if (!prop.trim() && !isOpex)                               issues.push('prop');
      if (hasSpecificProp && !cls.trim())                        issues.push('class');
      if (hasSpecificProp && !isOpex && !isGrounds) {
        const colon = prop.indexOf(':');
        if (colon === -1 || !prop.slice(colon + 1).trim())       issues.push('unit');
      }
      if (p.length < 3 && !isOpex)                              issues.push('cust');
      if (!t.notes || t.notes.trim().length < 3)                 issues.push('notes');
      return { id: t.id, date: t.date, name, dur: t.duration, prop, cls, path: p, notes: t.notes || '', issues };
    });

  save('audit.json', { fetched_at, entries });
  console.log('audit.json: ' + entries.length + ' entries');
}

function buildRampProcessed() {
  const rampPath = path.join(DATA_DIR, 'ramp.json');
  if (!fs.existsSync(rampPath)) { console.log('buildRampProcessed: ramp.json not found, skipping.'); return; }
  console.log('Building ramp_processed.json...');
  const { transactions, fetched_at } = JSON.parse(fs.readFileSync(rampPath, 'utf8'));

  const slim = transactions.map(t => {
    const dept = (t.accounting_categories || []).find(c => c.tracking_category_remote_id === 'QuickbooksDepartment');
    const cat  = (t.accounting_categories || []).find(c => c.tracking_category_remote_id === 'QuickbooksCategory');
    const cust = (t.accounting_categories || []).find(c => c.tracking_category_remote_id === 'QuickbooksCustomer');
    const custParts = (cust?.category_name || '').split(':');
    const wo = custParts.length >= 3 ? custParts[custParts.length - 1].trim() : null;
    return {
      d:    t.user_transaction_time.slice(0, 10),
      ln:   (t.card_holder?.last_name || '').toLowerCase().replace(/[^a-z]/g, ''),
      amt:  t.amount,
      dept: dept?.category_name || null,
      gl:   cat?.category_id    || null,
      wo:   wo || null,
    };
  });

  save('ramp_processed.json', { fetched_at, transactions: slim });
  console.log('ramp_processed.json: ' + slim.length + ' transactions (' + (JSON.stringify(slim).length / 1024).toFixed(0) + ' KB)');
}

// ── RAMP VENDOR BILLS (Bill Pay) ──────────────────────────────────────────────
// Fetches draft + submitted/paid vendor bills and explodes them to per-line-item
// records (a bill can split across GL accounts / properties). Property comes from
// the QuickbooksDepartment field (line-level, else bill-level); GL account number
// drives the report category. Property is often missing on drafts (it's in the memo)
// — the report buckets those as "Unassigned".
async function fetchRampBills() {
  if (!RAMP_CLIENT_ID || !RAMP_CLIENT_SECRET) { console.log('Ramp credentials not set, skipping bills.'); return; }
  console.log('Fetching Ramp bills...');
  const token = await fetchRampToken('bills:read accounting:read');

  const fieldOf = (sels, extId) => {
    const s = (sels || []).find(x => x.category_info && x.category_info.external_id === extId);
    return s ? (s.external_code || s.name || null) : null;
  };

  async function pageAll(base) {
    let out = [], start = null;
    while (true) {
      const qs = new URLSearchParams({ page_size: '100' });
      if (start) qs.set('start', start);
      const res = await fetchRamp(token, base + (base.includes('?') ? '&' : '?') + qs.toString());
      (res.data || []).forEach(b => out.push(b));
      if (!res.page || !res.page.next) break;
      start = new URL(res.page.next).searchParams.get('start');
      await sleep(120);
    }
    return out;
  }

  const drafts    = await pageAll('/developer/v1/bills/drafts');
  const submitted = await pageAll('/developer/v1/bills');

  // Merge by id (drafts and submitted are distinct objects, but guard anyway)
  const seen = new Set();
  const merged = [];
  [...drafts.map(b => ({ b, draft: true })), ...submitted.map(b => ({ b, draft: false }))].forEach(({ b, draft }) => {
    if (b.id && seen.has(b.id)) return;
    if (b.id) seen.add(b.id);
    merged.push({ b, draft });
  });

  // Explode to per-line-item records
  const lines = [];
  merged.forEach(({ b, draft }) => {
    if (b.archived_at) return; // skip archived/canceled
    const topDept = fieldOf(b.accounting_field_selections, 'QuickbooksDepartment');
    const vendor  = b.vendor_name || b.remote_name || null;
    const d       = (b.posting_date || b.due_at || b.created_at || '').slice(0, 10) || null;
    (b.line_items || []).forEach(li => {
      const conv = li.amount?.minor_unit_conversion_rate || 100;
      lines.push({
        d,
        amt:    (li.amount?.amount || 0) / conv,
        gl:     fieldOf(li.accounting_field_selections, 'QuickbooksCategory'),
        dept:   fieldOf(li.accounting_field_selections, 'QuickbooksDepartment') || topDept || null,
        status: b.status_summary || (draft ? 'DRAFT' : null),
        draft,
        vendor,
        memo:   (li.memo || '').slice(0, 120) || null,
      });
    });
  });

  save('ramp_bills.json', { ok: true, fetched_at: new Date().toISOString(), bills: lines });
  console.log('ramp_bills.json: ' + lines.length + ' line items from ' + merged.length + ' bills (' +
    drafts.length + ' draft, ' + submitted.length + ' submitted)');
}

// ── TURN COSTS ──────────────────────────────────────────────────────────────
const TC_WAGE_MAP = {
  'leeroy':50.00,'hippen':28.44,'hoard':27.00,'lakins':24.00,'leonides':25.00,
  'magoon':25.00,'mcquaid':25.00,'miller':28.09,'mitchell':27.00,'robson':23.00,
  'saldana':28.40,'sanchez':25.50,'uttke':34.00,'chavez':27.00,'cramer':25.75,
  'deckard':22.00,'dunlap':23.00,'gutierrez':25.00,'higley':31.99,
};
const TC_RAMP_CATS = {
  '52000':'R&M','52001':'R&M','52002':'R&M','52003':'R&M','67800':'R&M',
  '53000':'Turn','53001':'Turn','53002':'Turn','53003':'Turn',
  '54000':'Grounds','54001':'Grounds','54002':'Grounds','54003':'Grounds',
  '80121':'CapEx','80122':'CapEx','80130':'CapEx','80140':'CapEx',
};

// QBO vendor bills (qbo_processed.json) — vendor invoices keyed straight into
// QuickBooks never touch Ramp, so without these the turn actuals miss flooring,
// cleaning and subcontractor spend entirely.
//
// GL account number is authoritative and runs through TC_RAMP_CATS above. Bills
// pulled header-level carry no account number, only a category NAME, so these
// unambiguous names map onto the same buckets.
//
// Deliberately NOT mapped — a wrong guess silently misstates turn cost:
//   'Subcontractors'            generic catch-all; turn, R&M or capital work
//   'Uncategorized Expense'     uncoded at the source; fix it in QBO, not here
//   'Discretionary/Nondiscretionary - Contractor'  the CapEx buckets turn costs
//                               deliberately excludes (only 'CapEx Turns' counts)
//   'CapEX - Appliance'         appliance capital — same exclusion; mapping it to
//                               CapEx here would silently inflate turn spend
// Whatever falls through is reported in turn_costs.qboGap so the uncoded dollars
// stay visible instead of just vanishing.
//
// Both -Contractor and -Material exist for each bucket and both are real turn cost:
// omitting the Material half dropped $29,658 of turn spend on the first full pull.
const TC_QBO_NAME_CATS = {
  'turn - contractor':'Turn',        'turn - material':'Turn',
  'capex turn - contractor':'CapEx', 'capex turn - material':'CapEx',
  'r&m - contractor':'R&M',          'r&m - material':'R&M',
  'grounds - contractor':'Grounds',  'grounds - material':'Grounds',
};

function extractUnitCode(propField) {
  if (!propField) return null;
  const colon = propField.indexOf(':');
  if (colon === -1) return null;
  const unit = propField.slice(colon + 1).trim();
  return unit.includes('-') ? unit : null; // must be "propcode-unitnum" format
}

// Property code from a property/dept field, whether or not it carries a unit.
// Handles "Region:propcode-unit", "propcode (123)", "propcode-unit", etc.
function extractPropCode(propField) {
  if (!propField) return null;
  const seg = propField.includes(':') ? propField.slice(propField.lastIndexOf(':') + 1) : propField;
  const m = seg.match(/([a-z]{1,3}\d{2,3})/i);
  return m ? m[1].toLowerCase() : null;
}

function qbtToCat(cls) {
  if (!cls || !cls.includes(':')) return null;
  const sub = cls.split(':').slice(1).join(':');
  if (sub.startsWith('R&M')) return 'R&M';
  if (sub === 'Turn') return 'Turn';
  if (sub === 'Grounds') return 'Grounds';
  if (/capex/i.test(sub)) return 'CapEx';
  return null;
}

function buildTurnCosts() {
  const qbtPath  = path.join(DATA_DIR, 'qbtime.json');
  const rampPath = path.join(DATA_DIR, 'ramp_processed.json');
  if (!fs.existsSync(qbtPath)) { console.log('buildTurnCosts: qbtime.json missing, skipping.'); return; }
  console.log('Building turn_costs.json...');
  const qbt = JSON.parse(fs.readFileSync(qbtPath, 'utf8'));
  const units = {};
  // Property-level rollup of ALL turn spend (unit-tagged AND property-only),
  // daily-bucketed so the dashboard can filter by any period. Captures turn
  // spend coded to a property without a unit, which the per-unit map drops.
  const propSpend = {};
  function addPropSpend(pc, kind, date, amt) {
    if (!pc || !date) return;
    const p = propSpend[pc] || (propSpend[pc] = { labor: {}, materials: {} });
    p[kind][date] = Math.round(((p[kind][date] || 0) + amt) * 100) / 100;
  }

  function ensureUnit(code) {
    if (!units[code]) {
      const dash = code.indexOf('-');
      units[code] = { prop: dash > -1 ? code.slice(0, dash) : code, unitNum: dash > -1 ? code.slice(dash + 1) : code, labor: [], materials: [] };
    }
    return units[code];
  }

  for (const t of Object.values(qbt.timesheets || {})) {
    if (t.type !== 'regular') continue;
    const u = qbt.users?.[t.user_id];
    if (!u) continue;
    const raw = (u.display_name || '').trim();
    let empName, wage;
    if (raw.toLowerCase().includes('outright')) { empName = 'LeeRoy'; wage = 50.00; }
    else {
      const ln = raw.split(/\s+/).pop().toLowerCase().replace(/[^a-z]/g, '');
      wage = TC_WAGE_MAP[ln];
      if (wage === undefined) continue;
      empName = raw;
    }
    const cls = t.customfields?.['25056'] || '';
    const sub = cls.includes(':') ? cls.split(':').slice(1).join(':') : '';
    // Turn + CapEx Turns ONLY. Do NOT use qbtToCat here — it collapses every
    // CapEx class (Appliances, Discretionary, Non-Discretionary) to 'CapEx',
    // which would wrongly count non-turn capital labor as turn cost.
    if (sub !== 'Turn' && sub !== 'CapEx Turns') continue;
    const cat = sub === 'Turn' ? 'Turn' : 'CapEx';
    const hrs = Math.round(t.duration / 3600 * 100) / 100;
    const cost = Math.round(hrs * wage * 100) / 100;
    const propField = t.customfields?.['25068'];
    addPropSpend(extractPropCode(propField), 'labor', t.date, cost); // all turn labor, unit or not
    const unitCode = extractUnitCode(propField);
    if (unitCode) ensureUnit(unitCode).labor.push({ d: t.date, emp: empName, hrs, cost, cat });
  }

  if (fs.existsSync(rampPath)) {
    const ramp = JSON.parse(fs.readFileSync(rampPath, 'utf8'));
    for (const tx of (ramp.transactions || [])) {
      const cat = TC_RAMP_CATS[tx.gl];
      if (cat !== 'Turn' && cat !== 'CapEx') continue; // Turn + CapEx Turn materials
      addPropSpend(extractPropCode(tx.dept), 'materials', tx.d, tx.amt); // all turn materials, unit or not
      const unitCode = extractUnitCode(tx.dept);
      if (unitCode) ensureUnit(unitCode).materials.push({ d: tx.d, amt: tx.amt, cat, ln: tx.ln, src: 'ramp' });
    }
  }

  // QBO vendor bills — second materials source alongside Ramp. Same transaction
  // shape { gl, dept, d, amt, ln }, produced by qbo/to_reports_feed.js.
  //
  // No dedup against Ramp is needed. Ramp CARD spend (ramp_processed.json, the only
  // Ramp source this function reads) syncs to QBO as Purchase/Expense, never as a
  // Bill, so it cannot collide. Ramp BILL PAY was the one channel that could have —
  // and it is being retired in favour of keying vendor bills straight into QBO
  // (LeeRoy, 2026-08-07). ramp_bills.json feeds invoices_report only, not turn costs.
  // Vendor-bill reporting starts June 2026 — LeeRoy, 2026-08-10: "just june 2026 and
  // move forward." Earlier bills are coded too inconsistently to be worth carrying.
  // qbo/to_reports_feed.js already applies this floor; repeated here so the report
  // cannot silently include older bills if a wider feed is ever dropped in.
  const QBO_SINCE = '2026-06-01';
  const qboPath = path.join(DATA_DIR, 'qbo_processed.json');
  //
  // qboGap tracks bills whose category cannot be resolved to ANY cost bucket. It is
  // NOT a claim that this is all hidden turn spend — most of `Subcontractors` is
  // w225/r202/r203 renovation. It is the amount whose category leaves the question
  // unanswerable, split into the two problems, which have different fixes:
  //   ambiguous — a human has to recode it in QuickBooks
  //   split     — line detail exists in QBO, the header-level pull just can't see it,
  //               so the v3 OAuth API alone would recover these
  const qboGap = { total: 0, lines: 0, byCategory: {}, ambiguous: 0, split: 0, counted: 0 };
  let qboKept = 0;
  if (fs.existsSync(qboPath)) {
    const qbo = JSON.parse(fs.readFileSync(qboPath, 'utf8'));
    for (const tx of (qbo.transactions || [])) {
      if (!tx.d || tx.d < QBO_SINCE) continue;
      const cat = TC_RAMP_CATS[tx.gl] || TC_QBO_NAME_CATS[String(tx.qbo_category || '').trim().toLowerCase()];
      if (cat !== 'Turn' && cat !== 'CapEx') {
        // Not a turn line. Only flag categories that could be CONCEALING turn work.
        // Explicit non-turn buckets (Discretionary CapEx, Appliances, Auto, Postage…)
        // are correctly excluded and are not a gap.
        const c = String(tx.qbo_category || '(none)');
        const isSplit = /split/i.test(c);
        if (isSplit || /subcontract|uncategor/i.test(c)) {
          qboGap.total = Math.round((qboGap.total + tx.amt) * 100) / 100;
          qboGap.lines++;
          qboGap[isSplit ? 'split' : 'ambiguous'] = Math.round((qboGap[isSplit ? 'split' : 'ambiguous'] + tx.amt) * 100) / 100;
          qboGap.byCategory[c] = Math.round(((qboGap.byCategory[c] || 0) + tx.amt) * 100) / 100;
        }
        continue;
      }
      qboKept++;
      qboGap.counted = Math.round((qboGap.counted + tx.amt) * 100) / 100;
      addPropSpend(extractPropCode(tx.dept), 'materials', tx.d, tx.amt);
      const unitCode = extractUnitCode(tx.dept);
      if (unitCode) ensureUnit(unitCode).materials.push({ d: tx.d, amt: tx.amt, cat, ln: tx.vendor || tx.ln, src: 'qbo' });
    }
    console.log('  QBO bills: ' + qboKept + ' turn lines added' +
      (qboGap.lines ? '; ' + qboGap.lines + ' uncoded lines = $' + qboGap.total.toLocaleString() + ' NOT counted' : ''));
  }

  // Add estimates from AppFolio work orders.
  // A turn estimate lives on the 'Unit Turn' WO, but it is frequently ALSO
  // present on an 'Internal' "Turn Estimate - For Approval/Approved" WO for
  // the same unit. Summing both work-order types double-counts the estimate.
  // So: use the Unit Turn estimate(s) when present, and only fall back to
  // Internal turn-estimate WOs for units that have no Unit Turn WO yet.
  // Non-turn Internal WOs are ignored (must mention "turn" in the description).
  const woPath = path.join(DATA_DIR, 'workorders.json');
  if (fs.existsSync(woPath)) {
    const wo = JSON.parse(fs.readFileSync(woPath, 'utf8'));
    const turnEst = {}, internalEst = {};
    for (const r of (wo.rows || [])) {
      const est = parseFloat(r.estimate_amount) || 0;
      if (est <= 0) continue;
      const unitName = (r.unit_name || '').trim();
      if (!unitName) continue;
      const propMatch = (r.property_name || '').match(/([a-z]{1,3}\d{2,3})/i);
      if (!propMatch) continue;
      const code = propMatch[1].toLowerCase() + '-' + unitName;
      if (r.work_order_type === 'Unit Turn') {
        turnEst[code] = (turnEst[code] || 0) + est;
      } else if (r.work_order_type === 'Internal' && /turn/i.test(r.job_description || '')) {
        internalEst[code] = (internalEst[code] || 0) + est;
      }
    }
    for (const code of new Set([...Object.keys(turnEst), ...Object.keys(internalEst)])) {
      const est = turnEst[code] != null ? turnEst[code] : internalEst[code];
      ensureUnit(code).estimate = Math.round(est * 100) / 100;
    }
  }

  for (const u of Object.values(units)) {
    u.labor.sort((a, b) => b.d.localeCompare(a.d));
    u.materials.sort((a, b) => b.d.localeCompare(a.d));
  }

  // ── AppFolio turn end date per unit ────────────────────────────────────────
  // LeeRoy, 2026-08-12: "turn end dates should be when the unit turn work order is
  // marked completed in appfolio turn section, not the available date." So this is
  // `turn_end_date` from the unit_turn_detail report (AppFolio's Turn section) —
  // NOT rent-ready/available, and NOT the PropertyMeld completion date.
  //
  // ⚠️ Take the unit's LATEST turn, not its latest turn_end_date. A unit with an
  // open turn also has older completed ones; picking the max end date would stamp a
  // previous turn's completion onto the current one (kn47-k1-L105 would have read
  // 2025-10-01 for a turn that started 2025-10-02). Open turns are present in the
  // report with turn_end_date null, so selecting the latest turn by move_out_date
  // yields a blank for work still in progress, which is the honest answer.
  //
  // Keyed in the `propcode[-building]-unit` shape the cost map uses. AppFolio hangs
  // the building qualifier off the PROPERTY name ("kn47 K1") while the cost key hangs
  // it off the unit (`kn47-k1-H101`), so register both the qualified and plain key.
  const afTurns = {};
  const utdPath = path.join(DATA_DIR, 'unit_turn_detail.json');
  if (fs.existsSync(utdPath)) {
    for (const r of (JSON.parse(fs.readFileSync(utdPath, 'utf8')).rows || [])) {
      if (!r.unit) continue;
      const pc = extractPropCode(r.property);
      if (!pc) continue;
      const pn = String(r.property || '');
      const tail = pn.slice(pn.toLowerCase().indexOf(pc) + pc.length);
      const bld = (tail.match(/[a-z]?\d+[a-z]?/i) || [])[0] || null;
      const u = String(r.unit).trim();
      for (const k of (bld ? [`${pc}-${bld}-${u}`, `${pc}-${u}`] : [`${pc}-${u}`])) {
        const lk = k.toLowerCase();
        (afTurns[lk] || (afTurns[lk] = [])).push(r);
      }
    }
  }
  let afEndHits = 0;
  for (const [code, u] of Object.entries(units)) {
    const list = afTurns[code.toLowerCase()];
    if (!list || !list.length) continue;
    // Latest turn = latest move-out; unit_turn_id breaks ties and orders the rows
    // that carry no move-out date at all.
    const latest = list.slice().sort((a, b) =>
      String(a.move_out_date || '').localeCompare(String(b.move_out_date || '')) ||
      (Number(a.unit_turn_id) - Number(b.unit_turn_id))).pop();
    u.turnMoveOut = latest.move_out_date || null;
    if (latest.turn_end_date) { u.afTurnEnd = latest.turn_end_date; afEndHits++; }
  }

  // Completed-turn COUNT per property from PropertyMeld (the authoritative
  // turn-completion source). The vacancy snapshot can't date completions for
  // occupied units, so it can't count real turns — PropertyMeld can. Used for
  // "avg cost per turn" = property turn spend / completed turns. Only real
  // turn projects (name ~ "turn"), status COMPLETE; excludes Pest Control/Other.
  const pmPath = path.join(DATA_DIR, 'pm_turns.json');
  const propTurns = {};
  let turnEndHits = 0, fromTasks = 0;
  if (fs.existsSync(pmPath)) {
    const pmTurns = (JSON.parse(fs.readFileSync(pmPath, 'utf8')).turns) || [];
    for (const t of pmTurns) {
      if (!/turn/i.test(t.name || '') || t.status !== 'COMPLETE') continue;
      const m = (t.property || '').toLowerCase().replace(/\s+/g, '-').match(/([a-z]{1,3}\d{2,3})/);
      if (!m) continue;
      propTurns[m[1]] = (propTurns[m[1]] || 0) + 1;
    }

    // ── TURN END = FINAL WALKTHROUGH ────────────────────────────────────────
    // LeeRoy, 2026-08-12: "not the turn completion date in appfolio, we will use
    // the date of the final walkthrough." So Turn End is the date the Final
    // Walkthrough meld was COMPLETED in PropertyMeld.
    //
    // ⚠️ NOT `t.final_walk` — that is the SCHEDULED appointment and is routinely a
    // future date on an active turn (2027-02-09 on a turn running now). Using it
    // would put dates in the future in a "when did this finish" column.
    //
    // Two sources, in order:
    //   final_walk_done — completion of the final-walk meld, recorded by
    //                     fetchPropertyMeldWOs. Full history, but only populated
    //                     from the first cloud PM run after 2026-08-12.
    //   tasks[]         — the per-meld checklist, which already carries each
    //                     meld's `completed` date. Only kept for turns that are
    //                     open or finished within 120 days, so it covers recent
    //                     turns until final_walk_done backfills the rest.
    // Turns are matched to cost keys with findUnitCode, which handles PropertyMeld
    // putting the building qualifier on the PROPERTY name while the cost key puts
    // it on the unit.
    const walkByCode = {};
    for (const t of pmTurns) {
      if (!/turn/i.test(t.name || '') || /pest/i.test(t.name || '')) continue;
      let d = t.final_walk_done || null;
      if (!d && Array.isArray(t.tasks)) {
        for (const k of t.tasks) {
          if (!k.completed) continue;
          if (k.cat !== 'final-walk' && !/final\s*walk/i.test(k.task || '')) continue;
          if (!d || k.completed > d) d = k.completed;
          fromTasks++;
        }
      }
      if (!d) continue;
      const pc = extractPropCode(t.property);
      if (!pc || !t.unit) continue;
      const code = findUnitCode(units, pc, t.property, t.unit);
      // A unit can turn more than once; the most recent walkthrough is this row's.
      if (!walkByCode[code] || d > walkByCode[code]) walkByCode[code] = d;
    }
    for (const [code, d] of Object.entries(walkByCode)) {
      if (!units[code]) continue;   // findUnitCode falls back to a plain key that may not exist
      units[code].turnEnd = d;
      turnEndHits++;
    }
  }

  save('turn_costs.json', { ok: true, fetched_at: qbt.fetched_at, units, propSpend, propTurns, qboGap });
  console.log('turn_costs.json: ' + Object.keys(units).length + ' units, ' + Object.keys(propSpend).length + ' properties, ' +
    Object.keys(propTurns).length + ' props w/ completed PM turns, ' + turnEndHits + ' units w/ a completed final walkthrough'
    + ' (' + afEndHits + ' also have an AppFolio turn-end date, kept as afTurnEnd)');
}

// ── WEEKLY REPORT: TURNS COMPLETED MONTH-TO-DATE ─────────────────────────────
// Format fixed by LeeRoy 2026-08-10. Scope: turns COMPLETED this month to date —
// work done in earlier months still lands here as long as it completed this month
// and the cost is captured. Six columns, in this order:
//   completion date | property | unit | total cost | #days to complete | #days to turn
//
// Definitions, all confirmed by LeeRoy:
//   completion date  = PropertyMeld last-meld completion (`completed_date`). The only
//                      date that exists for EVERY completed turn, so it is what scopes
//                      rows into the month.
//   rent ready       = AppFolio rent-ready date. Both day-counts end here. It is NOT
//                      the completion date, and it goes blank once a unit re-rents —
//                      hence turn_ledger.json, which captures it before that happens.
//   #days to complete = move-out → rent ready
//   #days to turn     = first in-house appt (paint/maint, `first_appt`) → rent ready
//   total cost        = QBT labor + Ramp card materials + QuickBooks vendor bills,
//                       over the WHOLE turn (not a period slice).
// Rows are never dropped for missing dates — a blank cell says "not captured", which
// is honest; omitting the row would understate completed-turn count and cost.
// Resolve a PropertyMeld (property, unit) pair to the unit key used in turn_costs.
// Tries most-specific first so two units in different buildings can never collide.
// Matching is case-insensitive because the same building shows up as both `k3` and
// `K3` in real dept strings.
function findUnitCode(units, pc, propertyName, unit) {
  const u = String(unit).trim();
  const plain = `${pc}-${u}`;
  // Building qualifier = whatever follows the property code in the property name,
  // e.g. "kn47 K1" -> k1, "kn47-k3" -> k3. Absent for single-building properties.
  const tail = String(propertyName || '').slice(String(propertyName || '').toLowerCase().indexOf(pc) + pc.length);
  const bld = (tail.match(/[a-z]?\d+[a-z]?/i) || [])[0] || null;
  const cands = bld ? [`${pc}-${bld}-${u}`, plain] : [plain];
  const lc = {};
  for (const k of Object.keys(units)) lc[k.toLowerCase()] = k;
  // Exhaust each candidate (exact THEN case-insensitive) before dropping to a less
  // specific one — otherwise an exact hit on the plain key wins over the correct
  // building-qualified key that merely differs in case (`kn47-k3-k202` vs `-K202`).
  for (const c of cands) {
    if (units[c]) return c;
    if (lc[c.toLowerCase()]) return lc[c.toLowerCase()];
  }
  return plain;   // nothing matched — return the plain form so the row still renders at $0
}

function buildTurnsCompleted() {
  const pmPath = path.join(DATA_DIR, 'pm_turns.json');
  const tcPath = path.join(DATA_DIR, 'turn_costs.json');
  if (!fs.existsSync(pmPath)) { console.log('buildTurnsCompleted: pm_turns.json missing, skip.'); return; }
  const pm = JSON.parse(fs.readFileSync(pmPath, 'utf8'));
  const costs = fs.existsSync(tcPath) ? JSON.parse(fs.readFileSync(tcPath, 'utf8')) : { units: {} };

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const month = today.slice(0, 7);

  // Date lookups: live vacancy snapshot first, then the ledger for units that re-rented.
  const tvPath = path.join(DATA_DIR, 'turnvac.json');
  const ledPath = path.join(DATA_DIR, 'turn_ledger.json');
  const nrmU = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const byUnit = {};   // "propcode|unit" → { move_out, ready_date, src }
  const put = (prop, unit, mo, rd, src) => {
    const pc = extractPropCode(prop);
    if (!pc || !unit) return;
    const k = pc + '|' + nrmU(unit);
    const e = byUnit[k] || (byUnit[k] = {});
    if (mo && !e.move_out)   { e.move_out = mo;   e.mo_src = src; }
    if (rd && !e.ready_date) { e.ready_date = rd; e.rd_src = src; }
  };
  if (fs.existsSync(tvPath)) {
    for (const r of (JSON.parse(fs.readFileSync(tvPath, 'utf8')).rows || [])) {
      const ready = String(r.rent_ready || '').toLowerCase() === 'yes'
        ? (r.ready_for_showing_on || r.available_on || null) : null;
      put(r.property_name, r.unit, r.last_move_out || null, ready, 'vacancy');
    }
  }
  if (fs.existsSync(ledPath)) {
    const U = JSON.parse(fs.readFileSync(ledPath, 'utf8')).units || {};
    for (const e of Object.values(U)) put(e.prop, e.unit, e.move_out || null, e.ready_date || null, 'ledger');
  }

  const days = (a, b) => (a && b) ? Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5) : null;

  const rows = [];
  for (const t of (pm.turns || [])) {
    // Same completeness test as the completedByMonth rollup, so the two agree.
    if (t.status !== 'COMPLETE' || !/turn/i.test(t.name || '') || /pest/i.test(t.name || '')) continue;
    if (!t.completed_date) continue;
    const pc = extractPropCode(t.property);
    if (!pc || !t.unit) continue;
    // Cost keys carry the building qualifier for multi-building properties —
    // `kn47-k1-H101`, not `kn47-H101` (and kn47-k1-E205 / kn47-k2-E205 are different
    // units, so it cannot be ignored). PropertyMeld puts that qualifier on the
    // PROPERTY name ("kn47 K1", "kn47-k3") while the cost key puts it on the unit, so
    // try building-qualified first and fall back to the plain form.
    const code = findUnitCode(costs.units || {}, pc, t.property, t.unit);
    const u = costs.units?.[code];
    const labor = (u?.labor || []).reduce((s, e) => s + e.cost, 0);
    const mats  = (u?.materials || []).reduce((s, e) => s + e.amt, 0);
    const d = byUnit[pc + '|' + nrmU(t.unit)] || {};
    rows.push({
      completed:  t.completed_date,
      property:   t.property,
      prop_code:  pc,
      unit:       String(t.unit).trim(),
      labor:      Math.round(labor * 100) / 100,
      materials:  Math.round(mats * 100) / 100,
      total_cost: Math.round((labor + mats) * 100) / 100,
      move_out:   d.move_out || null,
      ready_date: d.ready_date || null,
      first_appt: t.first_appt || null,
      days_to_complete: days(d.move_out, d.ready_date),
      days_to_turn:     days(t.first_appt, d.ready_date),
      proj_id:    t.id,
    });
  }
  rows.sort((a, b) => b.completed.localeCompare(a.completed) || a.property.localeCompare(b.property));

  const summarize = (rs, forMonth) => {
    const n = rs.length;
    const avg = k => { const v = rs.map(r => r[k]).filter(x => x != null); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null; };
    return {
      month: forMonth, as_of: today, turns: n,
      total_cost:   Math.round(rs.reduce((s, r) => s + r.total_cost, 0) * 100) / 100,
      avg_cost:     n ? Math.round(rs.reduce((s, r) => s + r.total_cost, 0) / n * 100) / 100 : 0,
      avg_days_to_complete: avg('days_to_complete'),
      avg_days_to_turn:     avg('days_to_turn'),
      missing_move_out: rs.filter(r => !r.move_out).length,
      missing_ready:    rs.filter(r => !r.ready_date).length,
      zero_cost:        rs.filter(r => r.total_cost === 0).length,
    };
  };

  // Two outputs from one pass:
  //   turns_completed.json     — month-to-date ONLY. Format locked by LeeRoy 2026-08-10
  //                              and consumed by the standalone turns_completed.html.
  //                              Do not widen its scope; add to the _all file instead.
  //   turns_completed_all.json — every completed turn, so the Turns dashboard's
  //                              Completed tab can filter to any date range client-side.
  const mtd = rows.filter(r => r.completed.slice(0, 7) === month);
  save('turns_completed.json', { ok: true, fetched_at: new Date().toISOString(), summary: summarize(mtd, month), rows: mtd });
  save('turns_completed_all.json', {
    ok: true, fetched_at: new Date().toISOString(),
    summary: summarize(rows, null),
    first_completed: rows.length ? rows[rows.length - 1].completed : null,
    last_completed:  rows.length ? rows[0].completed : null,
    rows,
  });
  const mtdSummary = summarize(mtd, month);
  console.log(`turns_completed.json: ${mtd.length} turns completed in ${month} MTD, $${mtdSummary.total_cost.toLocaleString()}`
    + (mtdSummary.missing_ready ? ` (${mtdSummary.missing_ready} missing rent-ready date)` : ''));
  console.log(`turns_completed_all.json: ${rows.length} completed turns all-time`
    + (rows.length ? ` (${rows[rows.length - 1].completed} → ${rows[0].completed})` : ''));
}

// ── TURNS HUB ────────────────────────────────────────────────────────────────
// One record per unit currently in the turn pipeline, with EVERY fact about that
// unit already joined: vacancy dates, PropertyMeld project + task checklist,
// costs, estimate, schedule and risk flags.
//
// Why this exists: LeeRoy, 2026-08-13 — "too much here.. too many tabs.. too much
// info in different spots." That complaint is really a JOIN problem. The old report
// made the page re-derive the same unit identity in five places from three key
// shapes, so each tab could only show its own slice. Doing the join ONCE here means
// the hub page renders a row and expands a dossier without matching anything.
//
// Scope is the LIVE pipeline only (vacant/notice units + open PM turns + turns
// finished in the last 90 days). History, the property spend rollup and the dispatch
// grid stay in turns_completed_all.json / turn_costs.json / turn_schedule.json —
// the hub page loads those directly rather than duplicating them here.
function buildTurnsHub() {
  const P = n => path.join(DATA_DIR, n);
  const rd = n => { try { return JSON.parse(fs.readFileSync(P(n), 'utf8')); } catch (e) { return null; } };
  const tv    = rd('turnvac.json');
  if (!tv) { console.log('buildTurnsHub: turnvac.json missing, skip.'); return; }
  const pm    = rd('pm_turns.json')     || { turns: [] };
  const costs = rd('turn_costs.json')   || { units: {} };
  const sched = rd('turn_schedule.json')|| { turns: [], events: [] };
  const led   = rd('turn_ledger.json')  || { units: {} };

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const nrmU  = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const K     = (prop, unit) => { const pc = extractPropCode(prop); return pc && unit ? pc + '|' + nrmU(unit) : null; };
  const days  = (a, b) => (a && b) ? Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5) : null;

  // Region: the scheduler already knows it per property; city is the fallback for
  // properties no scheduler covers (Tacoma has no turn scheduler of its own).
  const regionByProp = {};
  for (const t of (sched.turns || [])) { const pc = extractPropCode(t.prop); if (pc && t.region) regionByProp[pc] = t.region; }
  for (const e of (sched.events || [])) { const pc = extractPropCode(e.prop); if (pc && e.region && !regionByProp[pc]) regionByProp[pc] = e.region; }
  const cityRegion = c => /spokane/i.test(c) ? 'Spokane'
    : /kennewick|pasco|richland|west richland|burbank/i.test(c) ? 'Tri-Cities'
    : /tacoma|lakewood|puyallup|federal way/i.test(c) ? 'Tacoma' : null;

  // ── index the sources by unit key ──
  const pmByKey = {};
  for (const t of (pm.turns || [])) {
    if (!/turn/i.test(t.name || '') || /pest/i.test(t.name || '')) continue;
    const k = K(t.property, t.unit);
    if (!k) continue;
    // Newest project wins when a unit has turned more than once.
    const cur = pmByKey[k];
    if (!cur || String(t.start_date || '') > String(cur.start_date || '')) pmByKey[k] = t;
  }
  const schedByKey = {};
  for (const t of (sched.turns || [])) { const k = K(t.prop, t.unit); if (k && (!schedByKey[k] || t.status === 'ACTIVE')) schedByKey[k] = t; }

  // Next scheduled appointment per unit, from the dispatch feed (today forward).
  const nextApptByKey = {};
  for (const e of (sched.events || [])) {
    if (!e.date || e.date < today) continue;
    if (/CANCEL/i.test(e.status || '')) continue;
    const k = K(e.prop, e.unit);
    if (!k) continue;
    if (!nextApptByKey[k] || e.date < nextApptByKey[k].date) nextApptByKey[k] = { date: e.date, cat: e.category, who: e.who, brief: e.brief };
  }

  // ── build one record per live unit ──
  const recs = {};
  const ensure = (prop, unit) => {
    const k = K(prop, unit);
    if (!k) return null;
    return recs[k] || (recs[k] = { key: k, prop: extractPropCode(prop), unit: String(unit).trim(), at_risk: [] });
  };

  for (const r of (tv.rows || [])) {
    if (EXCLUDED_PROPERTIES.includes(r.property_name)) continue;
    const rec = ensure(r.property_name, r.unit);
    if (!rec) continue;
    const vacant = String(r.unit_status || '').startsWith('Vacant-');
    Object.assign(rec, {
      property_name: r.property_name, city: r.city, addr: r.unit_address || r.address || null,
      unit_id: r.unit_id, unit_status: r.unit_status,
      // Notice-* = tenant still in place, so rent_ready is not meaningful yet.
      rent_ready: vacant ? r.rent_ready : null,
      vacant, days_vacant: vacant ? r.days_vacant : null,
      move_out: r.last_move_out || null, available_on: r.available_on || null,
      ready_on: r.ready_for_showing_on || null, target_date: r.unit_turn_target_date || null,
      next_move_in: r.next_move_in || null, rent: r.schd_rent || null,
      bed_bath: r.bed_and_bath || null, sqft: r.sqft || null,
    });
  }
  // Ledger fills move-out dates for units that already re-rented out of the snapshot.
  for (const e of Object.values(led.units || {})) {
    const k = K(e.prop, e.unit);
    if (!k || !recs[k]) continue;
    if (!recs[k].move_out && e.move_out) recs[k].move_out = e.move_out;
  }
  // Open PM turns for units the vacancy snapshot doesn't carry (already re-rented,
  // or a turn running on a unit that never showed vacant).
  for (const [k, t] of Object.entries(pmByKey)) {
    if (recs[k]) continue;
    if (t.status !== 'ACTIVE' && !(t.completed_date && t.completed_date >= new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10))) continue;
    recs[k] = { key: k, prop: extractPropCode(t.property), unit: String(t.unit).trim(), property_name: t.property, at_risk: [] };
  }

  // ── attach PM project, costs, schedule, stage and risk ──
  const STAGE_ORDER = ['Move-out', 'Walkthrough', 'Paint', 'Maintenance', 'Cleaning', 'Carpet', 'Final Walk', 'Ready'];
  let n = 0;
  for (const rec of Object.values(recs)) {
    const k = rec.key;
    const t = pmByKey[k];
    const s = schedByKey[k];
    rec.region = regionByProp[rec.prop] || cityRegion(rec.city || '') || (s && s.region) || null;

    if (t) {
      rec.pm = {
        projId: t.id, name: t.name, status: t.status,
        done: t.done_melds, total: t.total_melds,
        first_appt: t.first_appt || null,
        final_walk: t.final_walk || null,            // SCHEDULED — may be future
        final_walk_done: t.final_walk_done || null,  // COMPLETED = turn end
        completed_date: t.completed_date || null,
        due: (s && s.due) || null,
        next_task: (s && s.next_task) || null,
        tasks: Array.isArray(t.tasks) ? t.tasks : null,
      };
    }
    rec.next_appt = nextApptByKey[k] || null;

    // Cost: the cost map is keyed propcode[-building]-unit, so resolve through the
    // same helper the weekly report uses rather than guessing the key here.
    const code = findUnitCode(costs.units || {}, rec.prop, rec.property_name || rec.prop, rec.unit);
    const cu = (costs.units || {})[code];
    if (cu) {
      const labor = (cu.labor || []).reduce((a, e) => a + e.cost, 0);
      const mats  = (cu.materials || []).reduce((a, e) => a + e.amt, 0);
      rec.cost = {
        code,
        labor: Math.round(labor * 100) / 100,
        materials: Math.round(mats * 100) / 100,
        total: Math.round((labor + mats) * 100) / 100,
        estimate: cu.estimate || 0,
        laborEntries: (cu.labor || []).slice(0, 60),
        materialEntries: (cu.materials || []).slice(0, 60),
      };
      if (cu.turnEnd) rec.turn_end = cu.turnEnd;         // completed final walkthrough
      if (cu.afTurnEnd) rec.af_turn_end = cu.afTurnEnd;  // AppFolio turn section
    } else {
      rec.cost = { code, labor: 0, materials: 0, total: 0, estimate: 0, laborEntries: [], materialEntries: [] };
    }
    if (!rec.turn_end && rec.pm && rec.pm.final_walk_done) rec.turn_end = rec.pm.final_walk_done;

    // Stage = the next thing that has to happen. Ready once AppFolio says rent-ready.
    let stage = null;
    if (rec.rent_ready === 'Yes') stage = 'Ready';
    else if (rec.pm && rec.pm.tasks) {
      const open = rec.pm.tasks.filter(x => !x.done);
      const catStage = { paint: 'Paint', maintenance: 'Maintenance', cleaning: 'Cleaning', carpet: 'Carpet', 'final-walk': 'Final Walk', walkthrough: 'Walkthrough' };
      stage = open.length ? (catStage[open[0].cat] || 'Maintenance') : 'Final Walk';
    } else if (rec.pm && rec.pm.next_task) {
      stage = ({ paint: 'Paint', maint: 'Maintenance', maintenance: 'Maintenance', clean: 'Cleaning', cleaning: 'Cleaning', carpet: 'Carpet' })[rec.pm.next_task.task] || 'Maintenance';
    } else if (!rec.vacant && rec.move_out) stage = 'Move-out';
    rec.stage = stage;
    rec.stage_ord = Math.max(0, STAGE_ORDER.indexOf(stage || 'Move-out'));

    rec.days_elapsed = rec.move_out ? Math.max(0, days(rec.move_out, rec.turn_end || today)) : null;
    rec.days_to_turn = (rec.move_out && rec.turn_end) ? days(rec.move_out, rec.turn_end) : null;

    // Status the row is filtered by.
    rec.status = rec.turn_end ? 'complete'
      : rec.rent_ready === 'Yes' ? 'ready'
      : rec.vacant ? 'active'
      : rec.move_out ? 'notice' : 'other';

    // Risk flags — the exceptions that used to live on their own tab.
    // Only LIVE turns can be at risk: a finished turn that ran long is history, and
    // flagging it buries the handful of units that actually need a decision today.
    //
    // ⚠️ `unit_turn_target_date` is deliberately NOT a risk trigger. Measured
    // 2026-08-13: available_on is past target on 130 of 235 units, so it fires on
    // more than half the portfolio and tells you nothing. It's kept on the record as
    // `target_date` and shown in the dossier for reference, but it does not raise a
    // flag. If those targets are ever maintained, revisit this.
    if (rec.status === 'active' || rec.status === 'ready') {
      if (rec.available_on && rec.available_on < today && rec.rent_ready !== 'Yes') rec.at_risk.push('Available date passed');
      if (rec.status === 'active' && !rec.next_appt && !(rec.pm && rec.pm.next_task)) rec.at_risk.push('Nothing scheduled');
      if (rec.status === 'active' && rec.days_elapsed != null && rec.days_elapsed > 45) rec.at_risk.push('Over 45 days vacant');
      if (rec.next_move_in && rec.available_on && rec.available_on > rec.next_move_in) rec.at_risk.push('Move-in before ready');
    }
    n++;
  }

  const rows = Object.values(recs).sort((a, b) =>
    (b.at_risk.length - a.at_risk.length) ||
    String(a.prop).localeCompare(String(b.prop)) ||
    String(a.unit).localeCompare(String(b.unit)));

  const active = rows.filter(r => r.status === 'active');
  const summary = {
    as_of: today,
    units: rows.length,
    active: active.length,
    ready: rows.filter(r => r.status === 'ready').length,
    notice: rows.filter(r => r.status === 'notice').length,
    at_risk: rows.filter(r => r.at_risk.length).length,
    unscheduled: active.filter(r => !r.next_appt).length,
    accruing: Math.round(active.reduce((s, r) => s + (r.cost ? r.cost.total : 0), 0) * 100) / 100,
    avg_days_open: active.length ? Math.round(active.reduce((s, r) => s + (r.days_elapsed || 0), 0) / active.length) : null,
    revenue_at_risk: Math.round(active.reduce((s, r) => s + (parseFloat(r.rent) || 0) / 30, 0) * 100) / 100,
  };

  save('turns_hub.json', { ok: true, fetched_at: new Date().toISOString(), summary, rows });
  console.log(`turns_hub.json: ${rows.length} units (${summary.active} active, ${summary.at_risk} at risk, ${summary.unscheduled} unscheduled)`);
}

// ── TOOLS & SUPPLIES ─────────────────────────────────────────────────────────
function buildToolsSupplies() {
  const rampPath = path.join(DATA_DIR, 'ramp.json');
  if (!fs.existsSync(rampPath)) { console.log('buildToolsSupplies: ramp.json not found, skipping.'); return; }
  console.log('Building tools_supplies.json...');
  const { transactions, fetched_at } = JSON.parse(fs.readFileSync(rampPath, 'utf8'));

  const SINCE = '2026-04-01';

  const result = transactions
    .filter(t => {
      const d = t.user_transaction_time.slice(0, 10);
      if (d < SINCE) return false;
      const cat = (t.accounting_categories || []).find(c => c.tracking_category_remote_id === 'QuickbooksCategory');
      return cat && cat.category_id === '67800';
    })
    .map(t => {
      const dept = (t.accounting_categories || []).find(c => c.tracking_category_remote_id === 'QuickbooksDepartment');
      const fn = (t.card_holder?.first_name || '').trim();
      const ln = (t.card_holder?.last_name  || '').trim();
      return {
        date:      t.user_transaction_time.slice(0, 10),
        full_name: (fn + ' ' + ln).trim() || 'Unknown',
        amount:    t.amount,
        merchant:  t.merchant_name || '',
        memo:      t.memo || '',
        dept:      dept?.category_name || '',
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  save('tools_supplies.json', { ok: true, fetched_at, since: SINCE, transactions: result });
  console.log('tools_supplies.json: ' + result.length + ' transactions');
}

// ── APPLIANCES ────────────────────────────────────────────────────────────────
// Two strictly separate buckets — never combined. CLASS is authoritative:
//   capex = only items whose class is exactly "CapEx Appliances".
//   rm    = items whose class is exactly "R&M-Appliance", OR items that are
//           UNCLASSIFIED ("r203" only / blank class) AND whose note/memo names an
//           actual appliance. Unclassified items with no appliance mention are
//           dropped — the GL account alone never qualifies anything.
// Each line item carries a description of the appliance (Ramp memo/merchant or QBT note).
const APPL_WAGE_MAP = {
  'leeroy':50.00,'hippen':28.44,'hoard':27.00,'lakins':24.00,'leonides':25.00,
  'magoon':25.00,'mcquaid':25.00,'miller':28.09,'mitchell':27.00,'robson':23.00,
  'saldana':28.40,'sanchez':25.50,'uttke':34.00,'chavez':27.00,'cramer':25.75,
  'deckard':22.00,'dunlap':23.00,'gutierrez':25.00,'higley':31.99,
};
// Note/memo mentions an actual appliance — used to rescue UNCLASSIFIED ("r203"
// only) items into R&M. Explicitly-classed items don't need this.
const APPLIANCE_RE = /\b(appliances?|refrigerator|fridge|freezer|stove|oven|range|dishwasher|washer|dryer|microwave|disposal|air ?condition\w*|conditioner|ptac|a\/c)\b/i;

// Classify by class + note → 'capex', 'rm', or null (exclude).
function applianceBucket(cls, note) {
  cls = cls || '';
  if (cls === 'r203:CapEx Appliances') return 'capex';
  if (cls === 'r203:R&M-Appliance')    return 'rm';
  const sub = cls.includes(':') ? cls.split(':').slice(1).join(':').trim() : '';
  if (sub === '' && APPLIANCE_RE.test(note || '')) return 'rm'; // unclassified but note names an appliance
  return null;
}

function applPropCode(str) {
  if (!str) return null;
  const m = str.match(/([a-z]{1,3}\d{2,3})/i);
  return m ? m[1].toLowerCase() : null;
}
function applUnit(deptStr) {
  if (!deptStr) return '';
  const colon = deptStr.indexOf(':');
  return colon === -1 ? '' : deptStr.slice(colon + 1).trim();
}

function buildAppliances() {
  const rampPath = path.join(DATA_DIR, 'ramp.json');
  const qbtPath  = path.join(DATA_DIR, 'qbtime.json');
  console.log('Building appliances.json...');

  const capex = [];   // CapEx - Appliances line items
  const rm    = [];   // R&M - Appliance line items
  let fetched_at = new Date().toISOString();

  // ── Ramp materials ──────────────────────────────────────────────────────────
  if (fs.existsSync(rampPath)) {
    const { transactions, fetched_at: ra } = JSON.parse(fs.readFileSync(rampPath, 'utf8'));
    if (ra) fetched_at = ra;
    for (const t of transactions) {
      const cats  = t.accounting_categories || [];
      const cls   = cats.find(c => c.tracking_category_remote_id === 'QuickbooksClass')?.category_name || '';
      const dept  = cats.find(c => c.tracking_category_remote_id === 'QuickbooksDepartment')?.category_name || '';

      const bucket = applianceBucket(cls, t.memo);
      if (!bucket) continue;
      const isCapex = bucket === 'capex';

      const prop = applPropCode(dept);
      if (!prop) continue;
      const item = {
        date:     t.user_transaction_time.slice(0, 10),
        prop, unit: applUnit(dept),
        amount:   t.amount,
        type:     'Material',
        source:   'Ramp',
        merchant: t.merchant_name || '',
        desc:     (t.memo || '').trim(),
        who:      ((t.card_holder?.first_name || '') + ' ' + (t.card_holder?.last_name || '')).trim(),
      };
      (isCapex ? capex : rm).push(item);
    }
  } else {
    console.log('buildAppliances: ramp.json not found, materials omitted');
  }

  // ── QBT labor ─────────────────────────────────────────────────────────────
  if (fs.existsSync(qbtPath)) {
    const qbt = JSON.parse(fs.readFileSync(qbtPath, 'utf8'));
    for (const t of Object.values(qbt.timesheets || {})) {
      if (t.type !== 'regular') continue;
      const cls = t.customfields?.['25056'] || '';
      const bucket = applianceBucket(cls, t.notes);
      if (!bucket) continue;
      const isCapex = bucket === 'capex';

      const prop = applPropCode(t.customfields?.['25068']);
      if (!prop) continue;

      const u = qbt.users?.[t.user_id];
      const raw = (u?.display_name || '').trim();
      let who, wage;
      if (raw.toLowerCase().includes('outright')) { who = 'LeeRoy'; wage = 50.00; }
      else {
        const ln = raw.split(/\s+/).pop().toLowerCase().replace(/[^a-z]/g, '');
        wage = APPL_WAGE_MAP[ln];
        if (wage === undefined) continue; // not a field tech with a known rate
        who = (u.first_name || '') + ' ' + (u.last_name || '');
      }
      const hrs = Math.round(t.duration / 3600 * 100) / 100;
      if (hrs <= 0) continue;
      const item = {
        date:     t.date,
        prop, unit: applUnit(t.customfields?.['25068']),
        amount:   Math.round(hrs * wage * 100) / 100,
        hrs,
        type:     'Labor',
        source:   'QBT',
        merchant: '',
        desc:     (t.notes || '').trim(),
        who:      who.trim(),
      };
      (isCapex ? capex : rm).push(item);
    }
  } else {
    console.log('buildAppliances: qbtime.json not found, labor omitted');
  }

  capex.sort((a, b) => b.date.localeCompare(a.date));
  rm.sort((a, b) => b.date.localeCompare(a.date));

  save('appliances.json', { ok: true, fetched_at, capex, rm });
  console.log('appliances.json: ' + capex.length + ' CapEx appliance + ' + rm.length + ' R&M appliance line items');
}

const FIREBASE_API_KEY = 'AIzaSyAMAicBq6GIvo7p6s67n0wGoi1zuX21ybw';
const FIREBASE_PROJECT = 'ridgeview-estimates';
const FIRESTORE_BASE   = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const FIREBASE_AUTH_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;

const ESTIMATE_CATEGORIES = ['demo','drywall','paint','plumbing','electrical','flooring','carpet','carpet_cleaning','cabinets','appliances','windows','doors','hardware','cleaning'];

async function syncVacanciesToFirebase() {
  const email = process.env.FIREBASE_EMAIL;
  const pass  = process.env.FIREBASE_PASSWORD;
  if (!email || !pass) { console.log('Firebase sync skipped (no credentials)'); return; }

  const turnvacPath = path.join(DATA_DIR, 'turnvac.json');
  if (!fs.existsSync(turnvacPath)) { console.log('Firebase sync skipped (no turnvac.json)'); return; }

  const { rows } = JSON.parse(fs.readFileSync(turnvacPath, 'utf8'));
  const vacantUnits = rows.filter(r =>
    (r.unit_status === 'Vacant-Rented' || r.unit_status === 'Vacant-Unrented') && r.last_move_out
  );
  if (vacantUnits.length === 0) { console.log('Firebase sync: no vacant units'); return; }

  // Auth
  const authRes = await fetch(FIREBASE_AUTH_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pass, returnSecureToken: true }),
  });
  const { idToken, error: authErr } = await authRes.json();
  if (!idToken) { console.log('Firebase auth failed:', authErr?.message); return; }

  const headers = { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' };

  // Query existing estimate_needed records (just property + unit fields)
  const qRes = await fetch(`${FIRESTORE_BASE}:runQuery`, {
    method: 'POST', headers,
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'estimates' }],
      where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: 'companyId' }, op: 'EQUAL', value: { stringValue: 'ridgeview' } } },
        { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'estimate_needed' } } },
      ]}},
      select: { fields: [{ fieldPath: 'property' }, { fieldPath: 'unitNumber' }] },
    }}),
  });
  const existing = new Set();
  for (const item of await qRes.json()) {
    if (item.document) {
      const p = item.document.fields?.property?.stringValue   || '';
      const u = item.document.fields?.unitNumber?.stringValue || '';
      existing.add(p + '|' + u);
    }
  }

  // Add new units only
  let added = 0;
  for (const unit of vacantUnits) {
    const prop    = unit.property_name;
    const unitNum = unit.unit;
    if (existing.has(prop + '|' + unitNum)) continue;

    const now    = Date.now();
    const d      = new Date();
    const dateStr = d.toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    const num    = 'RRR-' + String(d.getFullYear()).slice(2) + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0') + '-' + String(Math.floor(Math.random()*9000)+1000);
    const docId  = now.toString() + Math.random().toString(36).slice(2,6);
    const notes  = `AppFolio status: ${unit.unit_status} · Move out: ${unit.last_move_out} · Rent ready: ${unit.rent_ready}`;

    const emptyItems = {};
    ESTIMATE_CATEGORIES.forEach(c => { emptyItems[c] = { arrayValue: { values: [] } }; });

    await fetch(`${FIRESTORE_BASE}/estimates?documentId=${docId}`, {
      method: 'POST', headers,
      body: JSON.stringify({ fields: {
        id:             { stringValue: docId },
        estimateNumber: { stringValue: num },
        date:           { stringValue: dateStr },
        property:       { stringValue: prop },
        unitNumber:     { stringValue: unitNum },
        preparedBy:     { stringValue: '' },
        preparedFor:    { stringValue: '' },
        status:         { stringValue: 'estimate_needed' },
        contingencyPct: { stringValue: '' },
        items:          { mapValue: { fields: emptyItems } },
        notes:          { stringValue: notes },
        photos:         { arrayValue: { values: [] } },
        createdBy:      { stringValue: 'appfolio-sync' },
        createdByName:  { stringValue: 'AppFolio Sync' },
        updatedAt:      { integerValue: now },
        companyId:      { stringValue: 'ridgeview' },
      }}),
    });

    existing.add(prop + '|' + unitNum);
    added++;
  }
  console.log(`Firebase sync: ${added} new move-out(s) added, ${vacantUnits.length - added} already listed`);
}

// ── PROPERTY MELD ─────────────────────────────────────────────────────────────
const PM_EMAIL    = process.env.PROPERTYMELD_EMAIL;
const PM_PASSWORD = process.env.PROPERTYMELD_PASSWORD;
const PM_HOST     = 'app.propertymeld.com';
const PM_MGMT     = '2975';

function pmReq(opts) {
  return new Promise((resolve, reject) => {
    const hdrs = { 'User-Agent': 'Mozilla/5.0', 'Accept': opts.accept || 'application/json' };
    if (opts.cookie)  hdrs['Cookie']       = opts.cookie;
    if (opts.csrf)    hdrs['X-CSRFToken']  = opts.csrf;
    if (opts.ctype)   hdrs['Content-Type'] = opts.ctype;
    if (opts.referer) hdrs['Referer']      = opts.referer;
    const body = opts.body ? Buffer.from(opts.body) : null;
    if (body) hdrs['Content-Length'] = body.length;
    const req = https.request(
      { hostname: PM_HOST, path: opts.path, method: opts.method || 'GET', timeout: 30000, headers: hdrs },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); }
    );
    req.on('timeout', () => req.destroy(new Error('PM timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function pmParseCookies(sc) {
  const jar = {};
  [].concat(sc || []).forEach(c => { const p = c.split(';')[0]; const eq = p.indexOf('='); if (eq > 0) jar[p.slice(0, eq).trim()] = p.slice(eq + 1).trim(); });
  return jar;
}
function pmCookieStr(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

async function pmLogin() {
  if (!PM_EMAIL || !PM_PASSWORD) throw new Error('PROPERTYMELD_EMAIL/PASSWORD not set');
  const r1 = await pmReq({ path: '/login/?next=/', accept: 'text/html' });
  const csrf1 = (r1.body.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/) || [])[1];
  if (!csrf1) throw new Error('PM login: no CSRF token found');
  let jar = pmParseCookies(r1.headers['set-cookie']);
  const loginBody = new URLSearchParams({ csrfmiddlewaretoken: csrf1, email: PM_EMAIL, password: PM_PASSWORD }).toString();
  const r2 = await pmReq({
    path: '/login/?next=/', method: 'POST', accept: 'text/html',
    ctype: 'application/x-www-form-urlencoded',
    referer: 'https://app.propertymeld.com/login/?next=/',
    cookie: pmCookieStr(jar), body: loginBody,
  });
  Object.assign(jar, pmParseCookies(r2.headers['set-cookie']));
  if (r2.status !== 302) throw new Error('PM login failed: status ' + r2.status);
  const r3 = await pmReq({ path: `/${PM_MGMT}/m/${PM_MGMT}/dashboard/`, accept: 'text/html', cookie: pmCookieStr(jar) });
  const csrf2 = (r3.body.match(/window\.PM\.csrf_token\s*=\s*"([^"]+)"/) || [])[1];
  return { cookie: pmCookieStr(jar), csrf: csrf2 || csrf1 };
}

async function pmGet(apiPath, session) {
  const r = await pmReq({ path: `/${PM_MGMT}/m/${PM_MGMT}${apiPath}`, cookie: session.cookie, csrf: session.csrf });
  if (r.status >= 400) throw new Error('PM ' + apiPath + ' status ' + r.status);
  return JSON.parse(r.body);
}

async function fetchPropertyMeldWOs() {
  if (!PM_EMAIL || !PM_PASSWORD) { console.log('PM credentials not set, skipping.'); return; }
  const qbtPath  = path.join(DATA_DIR, 'qbtime.json');
  const rampPath = path.join(DATA_DIR, 'ramp_processed.json');
  if (!fs.existsSync(qbtPath)) { console.log('fetchPropertyMeldWOs: qbtime.json missing, skipping.'); return; }

  // Collect WO reference IDs from QBT timesheets (R&M classes only)
  const qbt = JSON.parse(fs.readFileSync(qbtPath, 'utf8'));
  const RM_CLS_PM = ['R&M-Appliance', 'R&M-Electrical', 'R&M-Hardware', 'R&M-Pest Control', 'R&M-Plumbing'];
  const jcs = qbt.jobcodes || {};
  const woRefs = new Set();
  const jcCache = {};
  function getJcPathPM(id) {
    if (jcCache[id] !== undefined) return jcCache[id];
    const j = jcs[id];
    if (!j) return (jcCache[id] = []);
    if (j.parent_id === 0) return (jcCache[id] = [j.name]);
    return (jcCache[id] = [...getJcPathPM(j.parent_id), j.name]);
  }
  Object.values(qbt.timesheets || {}).forEach(t => {
    const cls = t.customfields?.['25056'] || '';
    if (!RM_CLS_PM.find(c => cls.includes(c))) return;
    const p = getJcPathPM(t.jobcode_id);
    if (p.length >= 3) woRefs.add(p[p.length - 1]);
  });
  if (fs.existsSync(rampPath)) {
    const ramp = JSON.parse(fs.readFileSync(rampPath, 'utf8'));
    (ramp.transactions || []).forEach(t => { if (t.wo) woRefs.add(t.wo); });
  }
  console.log(`PropertyMeld: ${woRefs.size} unique WO refs from QBT+Ramp`);
  if (woRefs.size === 0) return;

  // Load existing pm_wos.json for incremental merge
  const pmPath = path.join(DATA_DIR, 'pm_wos.json');
  let existing = {};
  if (fs.existsSync(pmPath)) {
    try { existing = JSON.parse(fs.readFileSync(pmPath, 'utf8')).melds || {}; }
    catch(e) { existing = {}; }
  }

  // Login
  console.log('PropertyMeld: logging in...');
  const session = await pmLogin();
  console.log('PropertyMeld: logged in');

  // Paginate all melds, collect those matching our WO refs
  const meldByRef = {};
  let offset = 0, total = '?', noNewStreak = 0;
  while (true) {
    const res = await pmGet(`/api/melds/?limit=100&offset=${offset}`, session);
    if (offset === 0 && res.count) { total = res.count; console.log(`PropertyMeld: ${total} total melds`); }
    const before = Object.keys(meldByRef).length;
    for (const m of (res.results || [])) {
      if (woRefs.has(m.reference_id)) meldByRef[m.reference_id] = m;
    }
    const found = Object.keys(meldByRef).length;
    process.stdout.write(`  melds offset=${offset}/${total} matched=${found}/${woRefs.size}\r`);
    if (found === before) { noNewStreak++; } else { noNewStreak = 0; }
    // Stop if: no more pages, no results, found everything, or 2000+ melds scanned with no new matches
    if (!res.next || (res.results || []).length === 0) break;
    if (found >= woRefs.size) break;
    if (noNewStreak >= 20) { process.stdout.write('\n'); console.log('PM: no new matches in 2000 melds, stopping early'); break; }
    offset += 100;
    await sleep(150);
  }
  console.log(`\nPropertyMeld: matched ${Object.keys(meldByRef).length}/${woRefs.size} WO references`);

  // Fetch comments for matched melds, 5 at a time concurrently.
  // Skip melds already COMPLETED+cached — their status & comments won't change.
  const result = { ...existing };
  const entries = Object.entries(meldByRef);
  const toFetch = entries.filter(([ref, m]) => {
    const ex = existing[ref];
    if (!ex) return true;
    if (m.status !== 'COMPLETED') return true;
    return false;
  });
  const skipped = entries.length - toFetch.length;
  console.log(`PM comments: fetching ${toFetch.length} (${skipped} completed+cached skipped)`);

  // Copy cached entries for melds we're skipping
  entries.forEach(([ref, meld]) => {
    if (!toFetch.find(([r]) => r === ref) && existing[ref]) result[ref] = existing[ref];
  });

  const BATCH = 5;
  let done = 0;
  for (let i = 0; i < toFetch.length; i += BATCH) {
    const chunk = toFetch.slice(i, i + BATCH);
    await Promise.all(chunk.map(async ([ref, meld]) => {
      let comments = [];
      try {
        const raw = await pmGet(`/api/comments/?meld=${meld.id}&limit=100`, session);
        const arr = Array.isArray(raw) ? raw : (raw.results || []);
        comments = arr.map(c => {
          const by = c.tenant
            ? ((c.tenant.first_name || '') + ' ' + (c.tenant.last_name || '')).trim()
            : c.agent
              ? ((c.agent?.user?.first_name || '') + ' ' + (c.agent?.user?.last_name || '')).trim()
              : (c.commenter_name || 'Unknown');
          return { by, type: c.clazz || 'm', text: (c.text || '').trim(), date: c.created };
        }).filter(c => c.text);
      } catch(e) {
        console.error(`\n  comments error ${ref}: ${e.message}`);
      }
      result[ref] = {
        id:          meld.id,
        ref:         meld.reference_id,
        description: meld.brief_description || '',
        status:      meld.status || '',
        completed:   meld.completed || null,
        property:    meld.unit?.prop?.property_name || '',
        unit:        meld.unit?.name || '',
        url:         `https://app.propertymeld.com/${PM_MGMT}/m/${PM_MGMT}/meld/${meld.id}/summary/`,
        comments,
      };
      done++;
    }));
    process.stdout.write(`  comments ${Math.min(done, toFetch.length)}/${toFetch.length}\r`);
    if (i + BATCH < toFetch.length) await sleep(50);
  }
  console.log(`\nPropertyMeld: saved ${Object.keys(result).length} total melds`);
  save('pm_wos.json', { ok: true, fetched_at: new Date().toISOString(), melds: result });
}

// ── PropertyMeld Turn Projects ────────────────────────────────────────────────
// Fetches TURN-type projects with their melds and appointment dates.
// Used for KPI tab: start lead time (move-out → first maintenance appt)
// and turn duration (first maint appt → final walkthrough).
async function fetchPropertyMeldTurns() {
  if (!PM_EMAIL || !PM_PASSWORD) { console.log('PM credentials not set, skipping turns fetch.'); return; }
  console.log('PropertyMeld turns: logging in...');
  const session = await pmLogin();
  console.log('PropertyMeld turns: logged in');

  const projects = [];
  let offset = 0;
  while (true) {
    const res = await pmGet(`/api/projects/?project_type=TURN&limit=100&offset=${offset}`, session);
    const rows = res.results || [];
    projects.push(...rows);
    process.stdout.write(`  projects ${projects.length}/${res.count || '?'}\r`);
    if (!res.next || rows.length === 0) break;
    offset += 100;
    await sleep(150);
  }
  console.log(`\nPropertyMeld turns: ${projects.length} TURN projects fetched`);

  const turns = [];
  const completedTurns = [];   // portfolio completed unit turns (fully complete), for by-month rollup
  const regionOf = c => { c = (c || '').trim(); if (['Spokane','Spokane Valley','Medical Lake'].includes(c)) return 'Spokane'; if (['Kennewick','Pasco','Richland','West Richland','Burbank'].includes(c)) return 'Tri-Cities'; if (c === 'Tacoma') return 'Tacoma'; return c || 'Other'; };
  const scheduleEvents = [];   // per-appointment feed for the turn dispatch calendar (Spokane + Tri-Cities)
  // Suggested-vendor-date baseline: remember the FIRST suggested cleaning/carpet date per turn so the
  // report can show "original -> new" when the in-house schedule shifts (e.g. early completion). Pruned to open turns.
  const SUGG_BASE_FILE = path.join(DATA_DIR, 'turn_suggested_baseline.json');
  let suggBase = {}; try { suggBase = JSON.parse(fs.readFileSync(SUGG_BASE_FILE, 'utf8')); } catch (e) { suggBase = {}; }
  const suggSeen = {};
  const suggEvent = (ev, kind, propName, unitLabel) => { const sk = nrm(propName) + '|' + nrm(unitLabel) + '|' + kind; suggSeen[sk] = 1; const orig = suggBase[sk]; if (orig === undefined) suggBase[sk] = ev.date; else if (orig !== ev.date) ev.origDate = orig; return ev; };
  const SPOK_CITIES = new Set(['Spokane', 'Spokane Valley', 'Medical Lake']);
  const TC_CITIES = new Set(['Kennewick', 'Pasco', 'Richland', 'West Richland', 'Burbank']);
  const DISPATCH_CITIES = new Set([...SPOK_CITIES, ...TC_CITIES, 'Tacoma']);   // Tacoma onboarded 2026-07-30
  const catOf = (b) => {
    b = b || '';
    if (/final\s*walk/i.test(b))                         return 'final-walk';
    if (/initial walkthrough|walk-?through|^a\s*[-–]/i.test(b)) return 'walkthrough';
    if (/carpet/i.test(b))                               return 'carpet';       // carpet clean OR replace
    if (/\bpaint\b|^c\s*[-–]/i.test(b))                  return 'paint';
    if (/floor/i.test(b))                                return 'flooring';
    if (/\bcleaning\b|^f\s*[-–]/i.test(b))               return 'cleaning';
    if (/maintenance|repair|^[bd]\s*[-–]/i.test(b))      return 'maintenance';
    if (/estimate/i.test(b))                             return 'estimate';
    return 'other';
  };
  const pac = (iso) => {
    const d = new Date(iso);
    return { date: d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
             time: d.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }) };
  };
  // Add N business days (Mon–Fri; vendors work Fridays, not weekends) to a YYYY-MM-DD date.
  const addBizDays = (isoDate, n) => {
    const d = new Date(isoDate + 'T12:00:00');
    let added = 0;
    while (added < n) { d.setDate(d.getDate() + 1); const wd = d.getDay(); if (wd !== 0 && wd !== 6) added++; }
    return d.toLocaleDateString('en-CA');
  };
  const SCHED_CUTOFF = new Date(Date.now() - 7 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // last 7 days + future
  // ---- turn dashboard extras: AppFolio move-in join + alerts engine ----
  const nrm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const moveInMap = {};
  try { (JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'turnvac.json'), 'utf8')).rows || []).forEach(r => { moveInMap[nrm(r.property_name) + '|' + nrm(r.unit)] = r.next_move_in || null; }); } catch (e) { console.log('turn dashboard: no turnvac.json for move-in join'); }
  const TODAY_ISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const dowN = iso => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(iso + 'T12:00:00Z').getUTCDay()];
  const STD_TASKS = new Set(['A - Initial walkthrough', 'C - Paint Prep / Paint', 'D - Maintenance']);
  const alerts = { unscheduled: [], moveInConflict: [], friday: [], weekend: [], pastDue: [], stalled: [], nearDone: [] };
  const spokTurns = [];
  let done = 0;
  const BATCH = 5;
  for (let i = 0; i < projects.length; i += BATCH) {
    const chunk = projects.slice(i, i + BATCH);
    await Promise.all(chunk.map(async (proj) => {
      try {
        const meldRes = await pmGet(`/api/melds/?project=${proj.id}&limit=50`, session);
        const melds = meldRes.results || [];

        // Meld classifiers
        const isMaint     = (b) => /^[bd]\s*[-–]/i.test(b) || /\bmaintenance\b|\brepair\b/i.test(b);
        const isPaint     = (b) => /^c\s*[-–]/i.test(b)    || /\bpaint\b/i.test(b);
        const isCleaning  = (b) => /^f\s*[-–]/i.test(b)    || (/\bcleaning\b/i.test(b) && !/carpet/i.test(b));
        const isCarpet    = (b) => /^e\s*[-–]/i.test(b)    || /carpet.*clean|clean.*carpet/i.test(b);
        const isFinalWalk = (b) => /final\s*walk/i.test(b);

        let firstApptDate    = null;  // first maint/paint appt  → turn work START
        let finalWalkDate    = null;  // final walkthrough appt   → turn work END
        let lastMaintPaint   = null;  // last maint OR paint appt → handoff to cleaners
        let lastClean        = null;  // last cleaning OR carpet  → cleaning done
        let cleanApptDate    = null;  // scheduled F-Cleaning appt (if any)
        let carpetApptDate   = null;  // scheduled E-Carpet appt   (if any)

        // Helper: get the scheduled date from either management or vendor appointment
        function getApptDate(m) {
          const mgmtAppt = (m.managementappointment || []).find(a => a.availability_segment?.event);
          if (mgmtAppt) return mgmtAppt.availability_segment.event.dtstart.slice(0, 10);
          // Vendor appointments for cleaning/carpet melds
          const vendAppt = (m.vendorappointment || []).find(a => a.availability_segment?.event);
          if (vendAppt) return vendAppt.availability_segment.event.dtstart.slice(0, 10);
          return null;
        }

        // Does a LIVE cleaning / carpet meld actually exist on this turn?
        // A cancelled or removed E-Carpet meld is MEANINGFUL, not missing data: per Lee Roy
        // (2026-07-30) it means either the unit has no carpet, or the carpet is being
        // REPLACED (which gets its own meld). Either way there is nothing to carpet-clean,
        // so no suggested-carpet date should be produced. Same reasoning for cleaning.
        // (`alive` mirrors pm_final_walkthrough.js, which already got this right; note that
        // a cancelled meld usually vanishes from /api/melds/?project= entirely, so absence
        // is the common case and the status check is belt-and-braces.)
        const aliveMeld = m => m.status !== 'MANAGER_CANCELED' && m.status !== 'TENANT_CANCELED';
        const notDone = m => m.status !== 'COMPLETED' && !m.completion_date;
        const hasLiveCleaningMeld = melds.some(m => isCleaning(m.brief_description || '') && aliveMeld(m) && notDone(m));
        const hasLiveCarpetMeld   = melds.some(m => isCarpet(m.brief_description || '')   && aliveMeld(m) && notDone(m));

        for (const m of melds) {
          const brief    = m.brief_description || '';
          const apptDate = getApptDate(m);
          if (!apptDate) continue;

          if (isMaint(brief) || isPaint(brief)) {
            if (!firstApptDate  || apptDate < firstApptDate)  firstApptDate  = apptDate;
            if (!lastMaintPaint || apptDate > lastMaintPaint) lastMaintPaint = apptDate;
          }
          if (isFinalWalk(brief)) {
            if (!finalWalkDate || apptDate > finalWalkDate) finalWalkDate = apptDate;
          }
          if (isCleaning(brief)) { if (!cleanApptDate  || apptDate < cleanApptDate)  cleanApptDate  = apptDate; }
          if (isCarpet(brief))   { if (!carpetApptDate || apptDate < carpetApptDate) carpetApptDate = apptDate; }
          if (isCleaning(brief) || isCarpet(brief)) {
            if (!lastClean || apptDate > lastClean) lastClean = apptDate;
          }
        }

        // Final walkthrough COMPLETION — the date the turn ended (LeeRoy, 2026-08-12).
        // Distinct from `final_walk` above, which is the scheduled appointment and is
        // routinely a future date on an active turn. Separate pass because the loop
        // above skips melds with no appointment, and a walkthrough can be completed
        // without one. Cancelled melds don't count as a walkthrough having happened.
        let finalWalkDone = null;
        for (const m of melds) {
          if (!isFinalWalk(m.brief_description || '') || !m.completion_date) continue;
          if (m.status === 'MANAGER_CANCELED' || m.status === 'TENANT_CANCELED') continue;
          const d = pac(m.completion_date).date;
          if (!finalWalkDone || d > finalWalkDone) finalWalkDone = d;
        }

        const unit = proj.unit;
        const propObj = unit?.prop || {};

        // portfolio completed-turns rollup: fully-complete unit turns (exclude pest + non-unit projects),
        // bucketed by the month of the LAST meld completion.
        {
          const fully = proj.total_melds > 0 && proj.total_completed_melds >= proj.total_melds;
          const hasUnit = unit && (unit.unit || unit.display_address?.line_2);
          if (fully && hasUnit && !/pest/i.test(proj.name || '')) {
            let mx = null;
            for (const m of melds) { if (m.completion_date) { const d = pac(m.completion_date).date; if (!mx || d > mx) mx = d; } }
            const uk = nrm(propObj.property_name) + '|' + nrm(unit.unit || unit.display_address?.line_2 || '');
            if (mx) completedTurns.push({ date: mx, region: regionOf(propObj.city), key: uk });
          }
        }

        // ---- Turn dispatch dashboard (Spokane + Tri-Cities): enriched events + alerts + per-turn rollup ----
        if (DISPATCH_CITIES.has((propObj.city || '').trim())) {
          const dregion = regionOf(propObj.city);
          const cleanVendor = dregion === 'Tri-Cities' ? 'Duo Cleaning' : dregion === 'Tacoma' ? "Dana's Quality Cleaning" : 'SPO Cleaning';
          const carpetVendor = dregion === 'Tri-Cities' ? 'SOS Carpet' : dregion === 'Tacoma' ? null : 'Allklean';   // Tacoma carpet vendor TBD — Lee Roy handling later
          const unitLabel = unit?.unit || unit?.display_address?.line_2 || '';
          const propName = propObj.property_name || '';
          const lbl = `${propName} ${unitLabel}`.trim();
          const addr = unit?.display_address ? [unit.display_address.line_1, unit.display_address.line_2, unit.display_address.city].filter(Boolean).join(', ') : (propObj.line_1 ? [propObj.line_1, propObj.city].filter(Boolean).join(', ') : '');
          const open = proj.total_melds > proj.total_completed_melds;
          const mi = moveInMap[nrm(propName) + '|' + nrm(unitLabel)] || null;
          const inh = c => c === 'walkthrough' || c === 'paint' || c === 'maintenance';
          let lastInhouse = null, nextTask = null;
          for (const m of melds) {
            const brief = m.brief_description || '', cat = catOf(brief), isDone = m.status === 'COMPLETED' || !!m.completion_date;
            const mgmt = (m.managementappointment || []).filter(a => a.availability_segment?.event?.dtstart);
            const vend = (m.vendorappointment || []).filter(a => a.availability_segment?.event?.dtstart);
            const techName = (m.in_house_servicers || [])[0]?.agent ? `${(m.in_house_servicers)[0].agent.first_name} ${(m.in_house_servicers)[0].agent.last_name}` : 'Unassigned';
            if (!isDone && cat !== 'estimate') {
              mgmt.forEach(a => { const e = a.availability_segment.event; const s = (a.management_assignment?.in_house_servicers || [])[0] || (m.in_house_servicers || [])[0]?.agent; const who = s ? `${s.first_name || ''} ${s.last_name || ''}`.trim() : 'Unassigned'; const p = pac(e.dtstart); scheduleEvents.push({ date: p.date, start: p.time, end: pac(e.dtend).time, prop: propName, unit: unitLabel, addr, category: cat, brief, who, whoType: 'tech', ref: m.reference_id, meld_id: m.id, projId: proj.id, status: m.status, region: dregion }); });
              vend.forEach(a => { const e = a.availability_segment.event; const vr = (m.vendor_assignment_requests || []).find(r => r.id === a.assignment_request) || (m.vendor_assignment_requests || [])[0]; const who = vr?.vendor?.name || 'Vendor'; const p = pac(e.dtstart); scheduleEvents.push({ date: p.date, start: p.time, end: pac(e.dtend).time, prop: propName, unit: unitLabel, addr, category: cat, brief, who, whoType: 'vendor', ref: m.reference_id, meld_id: m.id, projId: proj.id, status: m.status, region: dregion }); });
            }
            const apptDates = [...mgmt, ...vend].map(a => pac(a.availability_segment.event.dtstart).date);
            if (inh(cat)) apptDates.forEach(d => { if (d > (lastInhouse || '')) lastInhouse = d; });
            if (open) {
              if (STD_TASKS.has(brief.trim()) && apptDates.length === 0 && !isDone) alerts.unscheduled.push({ lbl, prop: propName, unit: unitLabel, task: brief.replace(' Prep / Paint', ''), status: m.status, projId: proj.id, region: dregion });
              for (const a of mgmt) { const d = pac(a.availability_segment.event.dtstart).date; const wd = dowN(d);
                if (inh(cat)) { if (wd === 'Sat' || wd === 'Sun') alerts.weekend.push({ lbl, task: brief, date: d, dow: wd, projId: proj.id, region: dregion }); else if (wd === 'Fri') alerts.friday.push({ lbl, task: brief.replace(' Prep / Paint', ''), date: d, projId: proj.id, region: dregion }); }
                if (!isDone && d < TODAY_ISO) alerts.pastDue.push({ lbl, prop: propName, unit: unitLabel, task: brief.replace(' Prep / Paint', ''), date: d, dow: wd, status: m.status, category: cat, who: techName, projId: proj.id, region: dregion });
              }
              apptDates.filter(d => d >= TODAY_ISO).forEach(d => { if (!nextTask || d < nextTask.date) nextTask = { date: d, task: cat }; });
            }
          }
          // ---- Suggested vendor dates (cleaning = 3 biz days after in-house; carpet next biz day) ----
          if (open && lastMaintPaint) {
            // Only suggest a vendor visit the turn is actually still waiting on. `cleanBase`
            // stays the timing anchor for carpet even when cleaning itself isn't suggested.
            const cleanBase = cleanApptDate || addBizDays(lastMaintPaint, 3);
            if (!cleanApptDate && hasLiveCleaningMeld) scheduleEvents.push(suggEvent({ date: cleanBase, start: '', end: '', prop: propName, unit: unitLabel, addr, category: 'suggested-cleaning', brief: `Suggested cleaning — 3 business days after in-house done (${lastMaintPaint})`, who: cleanVendor, whoType: 'suggested', ref: proj.id, projId: proj.id, status: 'SUGGESTED', region: dregion }, 'clean', propName, unitLabel));
            if (!carpetApptDate && hasLiveCarpetMeld && carpetVendor) { const carpetDate = addBizDays(cleanBase, 1); scheduleEvents.push(suggEvent({ date: carpetDate, start: '', end: '', prop: propName, unit: unitLabel, addr, category: 'suggested-carpet', brief: 'Suggested carpet cleaning — business day after cleaning', who: carpetVendor, whoType: 'suggested', ref: proj.id, projId: proj.id, status: 'SUGGESTED', region: dregion }, 'carpet', propName, unitLabel)); }
          }
          if (open) {
            if (mi && lastInhouse && lastInhouse > mi.slice(0, 10)) alerts.moveInConflict.push({ lbl, prop: propName, unit: unitLabel, lastInhouse, mi: mi.slice(0, 10), projId: proj.id, region: dregion });
            if (proj.due_date && proj.due_date.slice(0, 10) < TODAY_ISO) { const rec = { lbl, prop: propName, unit: unitLabel, due: proj.due_date.slice(0, 10), done: proj.total_completed_melds, total: proj.total_melds, projId: proj.id, region: dregion }; if (proj.total_completed_melds <= 2) alerts.stalled.push(rec); else alerts.nearDone.push(rec); }
          }
          spokTurns.push({ projId: proj.id, name: proj.name, region: dregion, prop: propName, unit: unitLabel, status: open ? 'ACTIVE' : 'COMPLETE', start: proj.start_date ? proj.start_date.slice(0,10) : null, due: proj.due_date ? proj.due_date.slice(0,10) : null, move_in: mi ? mi.slice(0,10) : null, done: proj.total_completed_melds, total: proj.total_melds, last_inhouse: lastInhouse, next_task: nextTask });
        }

        // ---- Per-turn task checklist (drives the Turns tab progress column) ----
        // One row per live meld: what it is, whether it's done, when it's scheduled, who has it.
        // Cancelled melds are dropped (a removed E-Carpet means "no carpet", not "missing data").
        // Only kept for turns that are still open or recently finished — old checklists are dead
        // weight in a file every report page loads.
        const taskRank = (b) => {
          const s = (b || '').trim();
          if (/final\s*walk/i.test(s)) return 90;
          const mm = /^([a-h])\s*[-–]/i.exec(s);
          if (mm) return 10 + (mm[1].toUpperCase().charCodeAt(0) - 65);
          if (/estimate/i.test(s)) return 10.5;   // right after A - Initial walkthrough

          return 50;
        };
        let lastDone = null;
        for (const m of melds) { if (m.completion_date) { const d = pac(m.completion_date).date; if (!lastDone || d > lastDone) lastDone = d; } }
        const keepTasks = proj.total_completed_melds < proj.total_melds
          || (lastDone && lastDone >= new Date(Date.now() - 120 * 86400000).toLocaleDateString('en-CA'));
        const tasks = !keepTasks ? undefined : melds
          .filter(m => m.status !== 'MANAGER_CANCELED' && m.status !== 'TENANT_CANCELED')
          .map(m => {
            const brief = m.brief_description || '';
            const isDone = m.status === 'COMPLETED' || !!m.completion_date;
            const hasVend = (m.vendorappointment || []).some(a => a.availability_segment?.event);
            const vr = (m.vendor_assignment_requests || [])[0];
            const svc = (m.in_house_servicers || [])[0]?.agent;
            const who = svc ? `${svc.first_name || ''} ${svc.last_name || ''}`.trim()
                      : vr?.vendor?.name || (hasVend ? 'Vendor' : '');
            return {
              task:      brief.replace(' Prep / Paint', ''),
              cat:       catOf(brief),
              done:      isDone,
              date:      getApptDate(m),
              who:       who || null,
              completed: m.completion_date ? pac(m.completion_date).date : null,
              vendor:    hasVend || (!svc && !!vr),
              rank:      taskRank(brief),
            };
          })
          .sort((a, b) => a.rank - b.rank || String(a.date || '9').localeCompare(String(b.date || '9')))
          .map(({ rank, ...t }) => t);

        turns.push({
          id:           proj.id,
          name:         proj.name,
          property:     propObj.property_name || '',
          unit:         unit?.unit || unit?.display_address?.line_2 || '',
          unit_id:      unit?.id || null,
          status:       proj.total_completed_melds === proj.total_melds ? 'COMPLETE' : 'ACTIVE',
          start_date:   proj.start_date ? proj.start_date.slice(0, 10) : null,
          due_date:     proj.due_date   ? proj.due_date.slice(0, 10)   : null,
          first_appt:      firstApptDate,
          final_walk:      finalWalkDate,   // SCHEDULED appt — may be in the future
          final_walk_done: finalWalkDone,   // COMPLETED walkthrough = turn end date
          last_maint_paint: lastMaintPaint,
          last_clean:       lastClean,
          // Date the turn finished = LAST meld completion. Same rule the completedTurns
          // rollup uses, so the weekly report and the by-month KPI can never disagree.
          // Present on ACTIVE turns too (it just means "latest meld done so far").
          completed_date: lastDone,
          total_melds:  proj.total_melds,
          done_melds:   proj.total_completed_melds,
          tasks,
        });
      } catch(e) {
        console.error(`\n  project ${proj.id} error: ${e.message}`);
      }
      done++;
    }));
    process.stdout.write(`  project melds ${Math.min(done, projects.length)}/${projects.length}\r`);
    await sleep(150);
  }
  console.log(`\nPropertyMeld turns: saved ${turns.length} turn records`);
  // last 6 months of completed turns (portfolio + by region)
  const completedByMonth = [];
  { const now = new Date();
    for (let i = 5; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const mr = completedTurns.filter(x => x.date.slice(0, 7) === key); const seen = {}; mr.forEach(x => { if (!seen[x.key]) seen[x.key] = x.region; }); const byRegion = {}; Object.values(seen).forEach(r => byRegion[r] = (byRegion[r] || 0) + 1);
      completedByMonth.push({ month: key, label: d.toLocaleString('en-US', { month: 'short' }), total: Object.keys(seen).length, byRegion }); } }
  save('pm_turns.json', { ok: true, fetched_at: new Date().toISOString(), turns, completedByMonth });
  scheduleEvents.sort((a, b) => a.date.localeCompare(b.date) || String(a.who).localeCompare(String(b.who)));
  const openCount = spokTurns.filter(t => t.status === 'ACTIVE').length;
  const kpis = { openTurns: openCount, totalTurnsShown: spokTurns.length, pastDue: alerts.pastDue.length, unscheduled: alerts.unscheduled.length, fridayViol: alerts.friday.length, moveInConflict: alerts.moveInConflict.length, stalled: alerts.stalled.length, atRisk: alerts.unscheduled.length + alerts.moveInConflict.length + alerts.friday.length + alerts.weekend.length + alerts.stalled.length };
  Object.keys(suggBase).forEach(k => { if (!suggSeen[k]) delete suggBase[k]; });   // prune closed turns so a future turn re-baselines
  try { fs.writeFileSync(SUGG_BASE_FILE, JSON.stringify(suggBase, null, 2)); } catch (e) {}
  save('turn_schedule.json', { ok: true, regions: ['Spokane', 'Tri-Cities'], fetched_at: new Date().toISOString(), today: TODAY_ISO, events: scheduleEvents, turns: spokTurns, alerts, kpis });
  console.log(`PropertyMeld turns: saved ${scheduleEvents.length} events, ${spokTurns.length} turns (Spokane + Tri-Cities), ${kpis.atRisk} at-risk`);
}

// ── PropertyMeld Tech Metrics ────────────────────────────────────────────────
// Fetches repair melds for all repair techs — saves slim records + QBT labor for KPI HTML.
async function fetchPMTechMetrics() {
  if (!PM_EMAIL || !PM_PASSWORD) { console.log('PM credentials not set, skipping tech metrics.'); return; }

  // PM agent ID, QBTime user ID, wage rate, display label
  const TECHS = [
    { name: 'Jonas Hoard',      id: 59983, key: 'jonas',   qbtId: 7623296, wage: 27.00, region: 'Tacoma'    },
    { name: 'Wade Hippen',      id: 48355, key: 'wade',    qbtId: 36898,   wage: 28.44, region: 'Spokane'   },
    { name: 'Justin Gutierrez', id: 59624, key: 'justin',  qbtId: 7564674, wage: 25.00, region: 'Spokane'   },
    { name: 'Jared Miller',     id: 48347, key: 'jared',   qbtId: 36902,   wage: 28.09, region: 'Tri-Cities'},
    { name: 'Jaxson Lakins',    id: 51579, key: 'jaxson',  qbtId: 6010510, wage: 24.00, region: 'Tri-Cities'},
    { name: 'Isaac Chavez',     id: 51605, key: 'isaac',   qbtId: 6010506, wage: 27.00, region: 'Tri-Cities'},
  ];
  const SIX_MONTHS_AGO = new Date(Date.now() - 190 * 86400000).toISOString().slice(0, 10);

  console.log('PM tech metrics: logging in...');
  const session = await pmLogin();
  console.log('PM tech metrics: logged in');

  const techMelds = {};
  TECHS.forEach(t => { techMelds[t.key] = []; });

  function tmGetAppt(m) {
    for (const a of (m.managementappointment || [])) {
      if (a.dtstart) return a.dtstart.slice(0, 10);
      if (a.availability_segment?.event?.dtstart) return a.availability_segment.event.dtstart.slice(0, 10);
    }
    return null;
  }
  function tmPriority(m) {
    const p = (m.priority || '').toLowerCase();
    if (p === 'emergency' || p === 'urgent') return 'Emergency';
    if (p === 'high') return 'High';
    if (p === 'low')  return 'Low';
    return 'Normal';
  }
  function slim(m, status) {
    return {
      id:        m.id,
      ref:       m.reference_id,
      brief:     (m.brief_description || '').slice(0, 80),
      status,
      priority:  tmPriority(m),
      created:   (m.created || '').slice(0, 10),
      completed: (m.completion_date || '').slice(0, 10) || null,
      first_appt: tmGetAppt(m),
      property:  m.unit?.prop?.property_name || m.prop?.property_name || '',
      work_type: m.work_type || '',
      rating:    m.tenant_rating != null ? +m.tenant_rating : null,
      review:    (m.tenant_review || '').trim().slice(0, 200) || null,
    };
  }

  // COMPLETED melds — paginate newest first, stop when older than ~6 months
  let offset = 0, total = '?', hitOld = false;
  while (!hitOld) {
    const res = await pmGet(`/api/melds/?status=COMPLETED&limit=100&offset=${offset}`, session);
    if (offset === 0) { total = res.count || '?'; console.log(`PM tech metrics: ${total} COMPLETED melds total`); }
    const rows = res.results || [];
    if (rows.length === 0) break;
    for (const m of rows) {
      const created = (m.created || '').slice(0, 10);
      if (created && created < SIX_MONTHS_AGO) { hitOld = true; break; }
      const ids = (m.in_house_servicers || []).filter(s => s.agent).map(s => s.agent.id);
      for (const t of TECHS) {
        if (ids.includes(t.id)) techMelds[t.key].push(slim(m, 'COMPLETED'));
      }
    }
    process.stdout.write(`  completed offset=${offset}/${total} j=${techMelds.jonas.length} w=${techMelds.wade.length} jg=${techMelds.justin.length}\r`);
    if (!res.next || rows.length < 100) break;
    offset += 100;
    await sleep(150);
  }
  console.log(`\nPM tech metrics: complete pass done`);

  // Active melds
  for (const status of ['PENDING_ASSIGNMENT','PENDING_COMPLETION','PENDING_MORE_MANAGEMENT_AVAILABILITY']) {
    let off = 0;
    while (true) {
      const res = await pmGet(`/api/melds/?status=${status}&limit=100&offset=${off}`, session);
      const rows = res.results || [];
      if (rows.length === 0) break;
      for (const m of rows) {
        const ids = (m.in_house_servicers || []).filter(s => s.agent).map(s => s.agent.id);
        for (const t of TECHS) {
          if (ids.includes(t.id)) techMelds[t.key].push(slim(m, status));
        }
      }
      if (!res.next || rows.length < 100) break;
      off += 100;
      await sleep(150);
    }
  }

  // ── QBTime labor hours per tech per WO reference ─────────────────────────
  // Builds {techKey: {woRef: totalHours}} from R&M timesheets in qbtime.json
  const laborByRef = {};
  TECHS.forEach(t => { laborByRef[t.key] = {}; });

  const qbtPath = path.join(DATA_DIR, 'qbtime.json');
  if (fs.existsSync(qbtPath)) {
    const qbt = JSON.parse(fs.readFileSync(qbtPath, 'utf8'));
    const qbtIdToKey = {};
    TECHS.forEach(t => { qbtIdToKey[t.qbtId] = t.key; });

    function getJcPath(id, cache, jcs) {
      if (cache[id] !== undefined) return cache[id];
      const j = jcs[id];
      if (!j) return (cache[id] = []);
      if (j.parent_id === 0) return (cache[id] = [j.name]);
      return (cache[id] = [...getJcPath(j.parent_id, cache, jcs), j.name]);
    }
    const jcCache = {}, jcs = qbt.jobcodes || {};

    Object.values(qbt.timesheets || {}).forEach(ts => {
      const key = qbtIdToKey[ts.user_id];
      if (!key) return;
      if (ts.type !== 'regular') return;
      const cls = ts.customfields?.['25056'] || '';
      if (!/r&m|repair|maintenance/i.test(cls)) return;
      const p = getJcPath(ts.jobcode_id, jcCache, jcs);
      const woRef = p.length >= 3 ? p[p.length - 1] : null;
      if (!woRef || !/^T[A-Z0-9]{6,}/i.test(woRef)) return; // must look like a PM ref
      const hrs = ts.duration / 3600;
      laborByRef[key][woRef] = (laborByRef[key][woRef] || 0) + hrs;
    });

    const totalEntries = Object.values(laborByRef).reduce((s, m) => s + Object.keys(m).length, 0);
    console.log(`QBT labor: ${totalEntries} WO-level entries across ${TECHS.length} techs`);
  } else {
    console.log('qbtime.json not found, labor costs will be omitted');
  }

  const summary = TECHS.map(t => `${t.key}=${techMelds[t.key].length}`).join(' ');
  save('pm_tech_metrics.json', {
    ok: true, fetched_at: new Date().toISOString(), since: SIX_MONTHS_AGO,
    techs: TECHS, melds: techMelds, labor_by_ref: laborByRef,
  });
  console.log(`PM tech metrics: ${summary}`);
}

// FETCH_ONLY env var controls what runs:
//   'appfolio'       → turnvac + workorders + budget (every 5 min)
//   'qbt-only'       → QBTime + audit.json only
//   'ramp-only'      → Ramp only (incremental 60-day window) + vendor bills
//   'bills-only'     → Ramp vendor bills only (ramp_bills.json)
//   'ramp-full'      → Ramp full re-fetch (150 days, ignores existing cache) + processed rebuild
//   'pm-only'        → PropertyMeld WOs + turns + tech metrics
//   'pm-tech-only'   → PropertyMeld tech metrics only (pm_tech_metrics.json)
//   'qbt-ramp'       → QBTime + Ramp (legacy, local use)
//   'costs-only'     → rebuild turn_costs.json from local files only (no network)
//   'turndetail-only'→ refetch AppFolio unit_turn_detail (turn end dates) + rebuild costs
//   'processed-only' → rebuild ramp_processed + audit + turn_costs from local files only
//   unset/'all'      → everything
const FETCH_ONLY = process.env.FETCH_ONLY || 'all';

(async () => {
  if (FETCH_ONLY === 'costs-only') {
    buildTurnCosts();
    buildTurnsCompleted(); buildTurnsHub();
    console.log('Done.');
    return;
  }

  if (FETCH_ONLY === 'turndetail-only') {
    await fetchUnitTurnDetail();
    buildTurnCosts();
    buildTurnsCompleted(); buildTurnsHub();
    console.log('Done.');
    return;
  }

  if (FETCH_ONLY === 'bills-only') {
    await fetchRampBills();
    console.log('Done.');
    return;
  }

  if (FETCH_ONLY === 'processed-only') {
    buildRampProcessed();
    buildAuditData();
    buildTurnCosts();
    buildToolsSupplies();
    buildAppliances();
    buildTurnsCompleted(); buildTurnsHub();
    console.log('Done.');
    return;
  }

  if (FETCH_ONLY === 'pm-only') {
    await fetchPropertyMeldWOs();
    await fetchPropertyMeldTurns();
    await fetchPMTechMetrics();
    buildTurnsCompleted(); buildTurnsHub();
    console.log('Done.');
    return;
  }

  if (FETCH_ONLY === 'moveout-only') {
    buildMoveoutChanges();
    buildTurnLedger();
    console.log('Done.');
    return;
  }

  if (FETCH_ONLY === 'turns-only') {
    await fetchPropertyMeldTurns();
    buildTurnsCompleted(); buildTurnsHub();
    console.log('Done.');
    return;
  }

  if (FETCH_ONLY === 'pm-tech-only') {
    await fetchPMTechMetrics();
    console.log('Done.');
    return;
  }

  if (FETCH_ONLY === 'pm-check-ratings') {
    const session = await pmLogin();
    const res = await pmGet('/api/melds/?status=COMPLETED&limit=100', session);
    const rated = (res.results || []).filter(m => m.tenant_rating != null);
    console.log('Total in page:', (res.results||[]).length, '| With rating:', rated.length);
    rated.slice(0, 8).forEach(m => console.log('rating:', JSON.stringify(m.tenant_rating), '| review:', JSON.stringify((m.tenant_review||'').slice(0,80))));
    const allRatings = (res.results||[]).map(m => m.tenant_rating).filter(v => v != null);
    const unique = [...new Set(allRatings.map(v => JSON.stringify(v)))];
    console.log('Unique rating values:', unique.join(', '));
    console.log('Done.');
    return;
  }

  if (FETCH_ONLY === 'pm-find-agents') {
    const session = await pmLogin();
    const targets = ['jaxson','jared','isaac','lakin','miller','chavez'];
    let offset = 0;
    while (true) {
      const res = await pmGet(`/api/melds/?status=PENDING_COMPLETION&limit=200&offset=${offset}`, session);
      const rows = res.results || [];
      rows.forEach(m => {
        (m.in_house_servicers||[]).forEach(s => {
          if (!s.agent) return;
          const fn = (s.agent.first_name||'').toLowerCase();
          const ln = (s.agent.last_name ||'').toLowerCase();
          if (targets.some(t => fn.includes(t) || ln.includes(t)))
            console.log('PM agent:', s.agent.id, s.agent.first_name, s.agent.last_name);
        });
      });
      if (!res.next || rows.length === 0) break;
      offset += 200;
      await sleep(150);
    }
    // Also check COMPLETED melds
    offset = 0;
    for (let i = 0; i < 5; i++) {
      const res = await pmGet(`/api/melds/?status=COMPLETED&limit=200&offset=${offset}`, session);
      const rows = res.results || [];
      rows.forEach(m => {
        (m.in_house_servicers||[]).forEach(s => {
          if (!s.agent) return;
          const fn = (s.agent.first_name||'').toLowerCase();
          const ln = (s.agent.last_name ||'').toLowerCase();
          if (targets.some(t => fn.includes(t) || ln.includes(t)))
            console.log('PM agent:', s.agent.id, s.agent.first_name, s.agent.last_name);
        });
      });
      if (!res.next || rows.length === 0) break;
      offset += 200;
      await sleep(150);
    }
    console.log('Done.');
    return;
  }

  if (FETCH_ONLY === 'ramp-full') {
    // Wipe existing ramp.json so fetchRampTransactions() does a fresh 150-day fetch
    const rampPath = path.join(DATA_DIR, 'ramp.json');
    if (fs.existsSync(rampPath)) {
      fs.unlinkSync(rampPath);
      console.log('Deleted existing ramp.json — will fetch full 150-day history');
    }
    await fetchRampTransactions();
    buildRampProcessed();
    buildAuditData();
    buildTurnCosts();
    buildToolsSupplies();
    buildAppliances();
    try { await fetchRampBills(); } catch(e) { console.error('Ramp bills fetch failed (non-fatal):', e.message); }
    console.log('Done.');
    return;
  }

  const runAppFolio = FETCH_ONLY === 'all' || FETCH_ONLY === 'appfolio';
  const runQBT      = FETCH_ONLY === 'all' || FETCH_ONLY === 'qbt-ramp' || FETCH_ONLY === 'qbt-only';
  const runRamp     = FETCH_ONLY === 'all' || FETCH_ONLY === 'qbt-ramp' || FETCH_ONLY === 'ramp-only';
  const runPM       = FETCH_ONLY === 'all' || FETCH_ONLY === 'qbt-ramp';

  if (runAppFolio) {
    try {
      await fetchTurnVac();
      buildMoveoutChanges(); // Rule A: flag move-out date changes / cancellations
      buildTurnLedger();     // capture move-out/rent-ready before units re-rent out of the snapshot
      await fetchWorkOrders();
      await fetchUnitTurnDetail();  // AppFolio turn-end dates for the Turn Costs tab
      await fetchBudget();
      await syncVacanciesToFirebase();
      buildTurnCosts(); // keep estimates fresh every 5 min
      buildTurnsCompleted(); buildTurnsHub();
    } catch(e) {
      console.error('AppFolio fetch failed:', e.message);
      process.exit(1);
    }
  }

  if (runQBT) {
    try { await fetchQBTime(); buildAuditData(); buildTurnCosts(); buildTurnsCompleted(); buildTurnsHub(); }
    catch(e) { console.error('QBTime fetch failed:', e.message); if (FETCH_ONLY === 'qbt-only') process.exit(1); }
  }

  if (runRamp) {
    try { await fetchRampTransactions(); buildRampProcessed(); buildTurnCosts(); buildToolsSupplies(); buildAppliances(); buildTurnsCompleted(); buildTurnsHub(); }
    catch(e) { console.error('Ramp fetch failed:', e.message); if (FETCH_ONLY === 'ramp-only') process.exit(1); }
    try { await fetchRampBills(); }
    catch(e) { console.error('Ramp bills fetch failed (non-fatal):', e.message); }
  }

  if (runPM) {
    try { await fetchPropertyMeldWOs(); await fetchPropertyMeldTurns(); }
    catch(e) { console.error('PropertyMeld fetch failed:', e.message); }
  }

  console.log('Done.');
})();
