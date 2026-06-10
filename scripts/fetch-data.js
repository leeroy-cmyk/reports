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
    if (cat !== 'Turn' && cat !== 'CapEx') continue; // Turn + CapEx Turn labor
    const hrs = Math.round(t.duration / 3600 * 100) / 100;
    ensureUnit(unitCode).labor.push({ d: t.date, emp: empName, hrs, cost: Math.round(hrs * wage * 100) / 100, cat });
  }

  if (fs.existsSync(rampPath)) {
    const ramp = JSON.parse(fs.readFileSync(rampPath, 'utf8'));
    for (const tx of (ramp.transactions || [])) {
      const unitCode = extractUnitCode(tx.dept);
      if (!unitCode) continue;
      const cat = TC_RAMP_CATS[tx.gl];
      if (cat !== 'Turn' && cat !== 'CapEx') continue; // Turn + CapEx Turn materials
      ensureUnit(unitCode).materials.push({ d: tx.d, amt: tx.amt, cat, ln: tx.ln });
    }
  }

  // Add estimates from AppFolio work orders
  const woPath = path.join(DATA_DIR, 'workorders.json');
  if (fs.existsSync(woPath)) {
    const wo = JSON.parse(fs.readFileSync(woPath, 'utf8'));
    for (const r of (wo.rows || [])) {
      if (!['Unit Turn', 'Internal'].includes(r.work_order_type)) continue;
      const est = parseFloat(r.estimate_amount) || 0;
      if (est <= 0) continue;
      const unitName = (r.unit_name || '').trim();
      if (!unitName) continue;
      const propMatch = (r.property_name || '').match(/([a-z]{1,3}\d{2,3})/i);
      if (!propMatch) continue;
      const code = propMatch[1].toLowerCase() + '-' + unitName;
      ensureUnit(code).estimate = Math.round(((units[code].estimate || 0) + est) * 100) / 100;
    }
  }

  for (const u of Object.values(units)) {
    u.labor.sort((a, b) => b.d.localeCompare(a.d));
    u.materials.sort((a, b) => b.d.localeCompare(a.d));
  }

  save('turn_costs.json', { ok: true, fetched_at: qbt.fetched_at, units });
  console.log('turn_costs.json: ' + Object.keys(units).length + ' units');
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

        // Helper: get the scheduled date from either management or vendor appointment
        function getApptDate(m) {
          const mgmtAppt = (m.managementappointment || []).find(a => a.availability_segment?.event);
          if (mgmtAppt) return mgmtAppt.availability_segment.event.dtstart.slice(0, 10);
          // Vendor appointments for cleaning/carpet melds
          const vendAppt = (m.vendorappointment || []).find(a => a.availability_segment?.event);
          if (vendAppt) return vendAppt.availability_segment.event.dtstart.slice(0, 10);
          return null;
        }

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
          if (isCleaning(brief) || isCarpet(brief)) {
            if (!lastClean || apptDate > lastClean) lastClean = apptDate;
          }
        }

        const unit = proj.unit;
        const propObj = unit?.prop || {};

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
          final_walk:      finalWalkDate,
          last_maint_paint: lastMaintPaint,
          last_clean:       lastClean,
          total_melds:  proj.total_melds,
          done_melds:   proj.total_completed_melds,
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
  save('pm_turns.json', { ok: true, fetched_at: new Date().toISOString(), turns });
}

// ── PropertyMeld Tech Metrics ────────────────────────────────────────────────
// Fetches repair melds for Wade, Justin, Jonas — saves slim records for KPI HTML.
async function fetchPMTechMetrics() {
  if (!PM_EMAIL || !PM_PASSWORD) { console.log('PM credentials not set, skipping tech metrics.'); return; }

  const TECHS = [
    { name: 'Jonas Hoard',      id: 59983, key: 'jonas'  },
    { name: 'Wade Hippen',      id: 48355, key: 'wade'   },
    { name: 'Justin Gutierrez', id: 59624, key: 'justin' },
  ];
  const SIX_MONTHS_AGO = new Date(Date.now() - 190 * 86400000).toISOString().slice(0, 10);

  console.log('PM tech metrics: logging in...');
  const session = await pmLogin();
  console.log('PM tech metrics: logged in');

  const techMelds = { jonas: [], wade: [], justin: [] };

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

  save('pm_tech_metrics.json', {
    ok: true, fetched_at: new Date().toISOString(), since: SIX_MONTHS_AGO,
    techs: TECHS, melds: techMelds,
  });
  console.log(`PM tech metrics: jonas=${techMelds.jonas.length} wade=${techMelds.wade.length} justin=${techMelds.justin.length}`);
}

// FETCH_ONLY env var controls what runs:
//   'appfolio'       → turnvac + workorders + budget (every 5 min)
//   'qbt-only'       → QBTime + audit.json only
//   'ramp-only'      → Ramp only (incremental 60-day window)
//   'ramp-full'      → Ramp full re-fetch (150 days, ignores existing cache) + processed rebuild
//   'pm-only'        → PropertyMeld WOs + turns + tech metrics
//   'pm-tech-only'   → PropertyMeld tech metrics only (pm_tech_metrics.json)
//   'qbt-ramp'       → QBTime + Ramp (legacy, local use)
//   'costs-only'     → rebuild turn_costs.json from local files only (no network)
//   'processed-only' → rebuild ramp_processed + audit + turn_costs from local files only
//   unset/'all'      → everything
const FETCH_ONLY = process.env.FETCH_ONLY || 'all';

(async () => {
  if (FETCH_ONLY === 'costs-only') {
    buildTurnCosts();
    console.log('Done.');
    return;
  }

  if (FETCH_ONLY === 'processed-only') {
    buildRampProcessed();
    buildAuditData();
    buildTurnCosts();
    buildToolsSupplies();
    console.log('Done.');
    return;
  }

  if (FETCH_ONLY === 'pm-only') {
    await fetchPropertyMeldWOs();
    await fetchPropertyMeldTurns();
    await fetchPMTechMetrics();
    console.log('Done.');
    return;
  }

  if (FETCH_ONLY === 'pm-tech-only') {
    await fetchPMTechMetrics();
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
      await fetchWorkOrders();
      await fetchBudget();
      await syncVacanciesToFirebase();
      buildTurnCosts(); // keep estimates fresh every 5 min
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
    try { await fetchRampTransactions(); buildRampProcessed(); buildTurnCosts(); buildToolsSupplies(); }
    catch(e) { console.error('Ramp fetch failed:', e.message); if (FETCH_ONLY === 'ramp-only') process.exit(1); }
  }

  if (runPM) {
    try { await fetchPropertyMeldWOs(); await fetchPropertyMeldTurns(); }
    catch(e) { console.error('PropertyMeld fetch failed:', e.message); }
  }

  console.log('Done.');
})();
