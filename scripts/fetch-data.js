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

(async () => {
  try {
    await fetchTurnVac();
    await fetchWorkOrders();
    await fetchBudget();
    console.log('All data fetched successfully.');
  } catch(e) {
    console.error('Fatal error:', e.message);
    process.exit(1);
  }
})();
