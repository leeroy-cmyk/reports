const https = require('https');
const fs = require('fs');
const path = require('path');

const AF_HOST = 'mckay.appfolio.com';
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
  const rows = Array.isArray(raw) ? raw : (raw.results || []);
  save('turnvac.json', { ok: true, count: rows.length, fetched_at: new Date().toISOString(), rows });
}

async function fetchWorkOrders() {
  console.log('Fetching work_order...');
  const raw = await fetchAF('/api/v2/reports/work_order.json', { property_visibility: 'active' });
  const rows = Array.isArray(raw) ? raw : (raw.results || raw.work_orders || []);
  save('workorders.json', { ok: true, count: rows.length, fetched_at: new Date().toISOString(), rows });
}

async function fetchBudget() {
  console.log('Fetching property directory...');
  const RM_CAPEX_ACCOUNTS = ['52001','52002','52003','80121','80122','80130','80140'];
  const today = new Date().toISOString().slice(0, 10);

  const propData = await fetchAF('/api/v2/reports/property_directory.json', { property_visibility: 'active' });
  const allProps = Array.isArray(propData) ? propData : (propData.results || []);
  const realProps = allProps.filter(p => p.property_id && p.property_city !== '*');
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

function fetchRampToken() {
  return new Promise((resolve, reject) => {
    const body = 'grant_type=client_credentials&scope=transactions:read';
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

  // On first run fetch 5 months; on subsequent runs fetch since last 2 days (overlap for safety)
  const hasExisting = Object.keys(existing).length > 0;
  const lookbackDays = hasExisting ? 2 : 150;
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
    return {
      d:    t.user_transaction_time.slice(0, 10),
      ln:   (t.card_holder?.last_name || '').toLowerCase().replace(/[^a-z]/g, ''),
      amt:  t.amount,
      dept: dept?.category_name || null,
      gl:   cat?.category_id    || null,
    };
  });

  save('ramp_processed.json', { fetched_at, transactions: slim });
  console.log('ramp_processed.json: ' + slim.length + ' transactions (' + (JSON.stringify(slim).length / 1024).toFixed(0) + ' KB)');
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
};

function extractUnitCode(propField) {
  if (!propField) return null;
  const colon = propField.indexOf(':');
  if (colon === -1) return null;
  const unit = propField.slice(colon + 1).trim();
  return unit.includes('-') ? unit : null; // must be "propcode-unitnum" format
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

  function ensureUnit(code) {
    if (!units[code]) {
      const dash = code.indexOf('-');
      units[code] = { prop: dash > -1 ? code.slice(0, dash) : code, unitNum: dash > -1 ? code.slice(dash + 1) : code, labor: [], materials: [] };
    }
    return units[code];
  }

  for (const t of Object.values(qbt.timesheets || {})) {
    if (t.type !== 'regular') continue;
    const unitCode = extractUnitCode(t.customfields?.['25068']);
    if (!unitCode) continue;
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
    const cat = qbtToCat(t.customfields?.['25056'] || '');
    if (!cat) continue;
    const hrs = Math.round(t.duration / 3600 * 100) / 100;
    ensureUnit(unitCode).labor.push({ d: t.date, emp: empName, hrs, cost: Math.round(hrs * wage * 100) / 100, cat });
  }

  if (fs.existsSync(rampPath)) {
    const ramp = JSON.parse(fs.readFileSync(rampPath, 'utf8'));
    for (const tx of (ramp.transactions || [])) {
      const unitCode = extractUnitCode(tx.dept);
      if (!unitCode) continue;
      const cat = TC_RAMP_CATS[tx.gl];
      if (!cat) continue;
      ensureUnit(unitCode).materials.push({ d: tx.d, amt: tx.amt, cat, ln: tx.ln });
    }
  }

  for (const u of Object.values(units)) {
    u.labor.sort((a, b) => b.d.localeCompare(a.d));
    u.materials.sort((a, b) => b.d.localeCompare(a.d));
  }

  save('turn_costs.json', { ok: true, fetched_at: qbt.fetched_at, units });
  console.log('turn_costs.json: ' + Object.keys(units).length + ' units');
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

// FETCH_ONLY env var controls what runs:
//   'appfolio'  → turnvac + workorders + budget (every 5 min)
//   'qbt-only'  → QBTime + audit.json only
//   'ramp-only' → Ramp only
//   'qbt-ramp'  → QBTime + Ramp (legacy, local use)
//   unset/'all' → everything
const FETCH_ONLY = process.env.FETCH_ONLY || 'all';

(async () => {
  const runAppFolio = FETCH_ONLY === 'all' || FETCH_ONLY === 'appfolio';
  const runQBT      = FETCH_ONLY === 'all' || FETCH_ONLY === 'qbt-ramp' || FETCH_ONLY === 'qbt-only';
  const runRamp     = FETCH_ONLY === 'all' || FETCH_ONLY === 'qbt-ramp' || FETCH_ONLY === 'ramp-only';

  if (runAppFolio) {
    try {
      await fetchTurnVac();
      await fetchWorkOrders();
      await fetchBudget();
      await syncVacanciesToFirebase();
    } catch(e) {
      console.error('AppFolio fetch failed:', e.message);
      process.exit(1);
    }
  }

  if (runQBT) {
    try { await fetchQBTime(); buildAuditData(); buildTurnCosts(); }
    catch(e) { console.error('QBTime fetch failed:', e.message); if (FETCH_ONLY === 'qbt-only') process.exit(1); }
  }

  if (runRamp) {
    try { await fetchRampTransactions(); buildRampProcessed(); buildTurnCosts(); }
    catch(e) { console.error('Ramp fetch failed:', e.message); if (FETCH_ONLY === 'ramp-only') process.exit(1); }
  }

  console.log('Done.');
})();
