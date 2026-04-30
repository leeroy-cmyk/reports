// fetch-invoices.js — Gmail invoice scan + Ramp vendor comparison
// Writes data/invoices.json
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
//      RAMP_CLIENT_ID, RAMP_CLIENT_SECRET

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Google OAuth ──────────────────────────────────────────────────────────────
function getGoogleToken() {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }).toString();
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const j = JSON.parse(d);
        if (!j.access_token) reject(new Error('Google token error: ' + d));
        else resolve(j.access_token);
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function gmailGet(token, p) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'gmail.googleapis.com', path: p, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d.slice(0,300))); } });
    });
    req.on('error', reject); req.end();
  });
}

async function gmailSearch(token, query, max = 300) {
  const ids = [];
  let pageToken = null;
  while (ids.length < max) {
    const qs = new URLSearchParams({ q: query, maxResults: '100' });
    if (pageToken) qs.set('pageToken', pageToken);
    const res = await gmailGet(token, '/gmail/v1/users/me/messages?' + qs);
    if (res.messages) ids.push(...res.messages.map(m => m.id));
    if (!res.nextPageToken || ids.length >= max) break;
    pageToken = res.nextPageToken;
    await sleep(150);
  }
  return ids.slice(0, max);
}

async function getMeta(token, id) {
  const res = await gmailGet(token,
    '/gmail/v1/users/me/messages/' + id +
    '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date');
  const h = (res.payload?.headers || []).reduce((a, x) => { a[x.name] = x.value; return a; }, {});
  return { id, subject: h.Subject || '', from: h.From || '', date: h.Date || '' };
}

// ── Ramp ─────────────────────────────────────────────────────────────────────
function getRampToken() {
  return new Promise((resolve, reject) => {
    const body = 'grant_type=client_credentials&scope=transactions:read';
    const auth = Buffer.from(process.env.RAMP_CLIENT_ID + ':' + process.env.RAMP_CLIENT_SECRET).toString('base64');
    const req = https.request({
      hostname: 'api.ramp.com', path: '/developer/v1/token', method: 'POST',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).access_token); } catch(e) { reject(new Error(d)); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function rampGet(token, p) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.ramp.com', path: p, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d.slice(0,200))); } });
    });
    req.on('error', reject); req.end();
  });
}

async function fetchRampVendors(days = 60) {
  const token = await getRampToken();
  const fromTime = new Date(Date.now() - days * 86400000).toISOString();
  const vendors = {};
  let nextStart = null;
  while (true) {
    const qs = new URLSearchParams({ from_time: fromTime, limit: '100' });
    if (nextStart) qs.set('start', nextStart);
    const res = await rampGet(token, '/developer/v1/transactions?' + qs);
    for (const t of res.data || []) {
      const m = (t.merchant_name || '').trim();
      if (!m) continue;
      if (!vendors[m]) vendors[m] = { total: 0, count: 0 };
      vendors[m].total = Math.round((vendors[m].total + (parseFloat(t.amount) || 0)) * 100) / 100;
      vendors[m].count++;
    }
    if (!res.page?.next) break;
    const u = new URL(res.page.next);
    nextStart = u.searchParams.get('start');
    await sleep(100);
  }
  return vendors;
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

// Extract dollar amount from subject line
function extractAmount(subject) {
  const m = subject.match(/\$([0-9,]+\.\d{2})/);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

// Extract invoice number from subject line
function extractInvoiceNum(subject) {
  // "Invoice 23334389", "Invoice #1279", "invoice 1193 ", "#000518", "211027JR3918", "257178675"
  const patterns = [
    /Invoice\s*#?\s*([A-Z0-9]{5,})/i,
    /#([0-9]{3,})\b/,
    /invoice\s+(\d{4,})/i,
  ];
  for (const p of patterns) {
    const m = subject.match(p);
    if (m) return m[1];
  }
  return null;
}

// Extract vendor name from subject or From header
function extractVendor(subject, from) {
  // "Invoice from Duo Cleaning Company LLC"
  // "New payment request from Virtel Flooring Services LLC - invoice 1193"
  // "Payment confirmation: Invoice #1279-(U&K Properties LLC)"
  // "Your Invoice 257475425 from Allklean Cleaning & Restoration"
  // "Reminder: Invoice 23334389 is due from Duo Cleaning Company LLC - $350.00"
  let m = subject.match(/(?:from|request from|payment to)\s+([A-Za-z0-9&' .,]+?)(?:\s*[-–(]|\s*-\s*invoice|\s+for\s+\$|$)/i);
  if (m) return m[1].trim();
  // Payment confirmation: "Invoice #XXX-(Vendor Name)"
  m = subject.match(/Invoice\s*#[\w-]+[-–]\(?(.+?)\)?$/i);
  if (m) return m[1].trim();
  // From header fallback
  m = from.match(/^"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : from.split('@')[0];
}

// Normalize vendor name to canonical form
const VENDOR_ALIASES = {
  'Duo Cleaning Compa': 'Duo Cleaning Company LLC',
  'Virtel Flooring Se': 'Virtel Flooring Services LLC',
  'Allklean Carpet Cleaning and Restoration': 'Allklean Cleaning and Restoration',
  'Allklean': 'Allklean Cleaning and Restoration',
  'Pointe Pest Control': 'Pointe Pest Control',
  'SOS Carpet & Upholstery Cleaning': 'SOS Carpet & Upholstery Cleaning',
  'U&K Properties': 'U&K Properties LLC',
};

// Map normalized email vendor → Ramp merchant name prefix for lookup
const EMAIL_TO_RAMP = {
  'Duo Cleaning Company LLC': 'Duo Cleaning',
  'Allklean Cleaning and Restoration': 'Allklean',
  'Virtel Flooring Services LLC': 'Virtel Flooring',
  'Pointe Pest Control': 'Pointe Pest',
  'SOS Carpet & Upholstery Cleaning': 'SOS Carpet',
  "U&K Properties LLC": 'U&K Properties',
  'Malone\'s Landscape Management, Inc': 'Malone',
};

function rampDataForVendor(emailVendor, rampVendors) {
  const prefix = EMAIL_TO_RAMP[emailVendor];
  if (!prefix) return null;
  let total = 0, count = 0;
  for (const [name, data] of Object.entries(rampVendors)) {
    if (name.toLowerCase().startsWith(prefix.toLowerCase())) {
      total += data.total;
      count += data.count;
    }
  }
  return count > 0 ? { total: Math.round(total * 100) / 100, count } : null;
}

// Classify a message as 'paid', 'reminder', 'invoice', or 'other'
function classify(subject) {
  const s = subject.toLowerCase();
  if (s.includes('payment confirmation') || s.includes('you paid an invoice')) return 'paid';
  if (s.includes('reminder') && (s.includes(' due') || s.includes('past due') || s.includes('is due'))) return 'reminder';
  if (s.includes('invoice reminder')) return 'reminder';
  if (s.includes('new payment request') || s.includes('you have an invoice waiting') ||
      s.includes('you received a new invoice') || s.includes('invoice from ') ||
      s.includes('your invoice ') || /invoice\s+\d/.test(s) ||
      s.includes('balance on invoice') || s.includes('invoice attached') ||
      s.includes('maintenance invoice')) return 'invoice';
  return 'other';
}

function parseDateToISO(dateStr) {
  try { return new Date(dateStr).toISOString().slice(0, 10); } catch { return null; }
}

function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const DAYS = 60;
  const afterDate = new Date(Date.now() - DAYS * 86400000);
  const gmailAfter = afterDate.toISOString().slice(0, 10).replace(/-/g, '/');

  console.log('Getting Google token...');
  const gToken = await getGoogleToken();

  // Search Gmail for all invoice-related subjects
  const query = `subject:(invoice OR bill OR statement OR "payment confirmation" OR "payment request") after:${gmailAfter}`;
  console.log('Searching Gmail:', query);
  const msgIds = await gmailSearch(gToken, query, 400);
  console.log('Found', msgIds.length, 'messages, fetching metadata...');

  // Fetch metadata in batches of 20 (with delay to avoid rate limits)
  const messages = [];
  for (let i = 0; i < msgIds.length; i++) {
    try {
      const meta = await getMeta(gToken, msgIds[i]);
      messages.push(meta);
    } catch (e) {
      console.error('  Skipped', msgIds[i], ':', e.message.slice(0, 60));
    }
    if (i > 0 && i % 20 === 0) {
      process.stdout.write('  ' + i + '/' + msgIds.length + '\r');
      await sleep(200);
    }
  }
  console.log('\nFetched', messages.length, 'message metadata entries');

  // ── Classify and parse ────────────────────────────────────────────────────
  const invoiceMap = {};  // key: vendor::invoiceNum → invoice record
  const paidSet = new Set(); // vendor::invoiceNum that have payment confirmations

  for (const msg of messages) {
    const type = classify(msg.subject);
    if (type === 'other') continue;

    const vendor = extractVendor(msg.subject, msg.from);
    const invNum = extractInvoiceNum(msg.subject);
    const amount = extractAmount(msg.subject);
    const dateISO = parseDateToISO(msg.date);
    const key = vendor.slice(0, 30) + '::' + (invNum || 'nonum_' + msg.id);

    if (type === 'paid') {
      paidSet.add(key);
      // Also try matching by invoice number alone if vendor extraction differs
      if (invNum) paidSet.add('::' + invNum);
      continue;
    }

    if (type === 'invoice') {
      if (!invoiceMap[key]) {
        invoiceMap[key] = {
          vendor, invoice_num: invNum, amount, invoice_date: dateISO,
          subject: msg.subject, gmail_id: msg.id, reminder_count: 0,
        };
      }
      // Update amount if this record is better (has dollar amount)
      if (!invoiceMap[key].amount && amount) invoiceMap[key].amount = amount;
    }

    if (type === 'reminder') {
      // Reminder means definitely unpaid — create or update the invoice record
      if (!invoiceMap[key]) {
        invoiceMap[key] = {
          vendor, invoice_num: invNum, amount, invoice_date: dateISO,
          subject: msg.subject, gmail_id: msg.id, reminder_count: 0,
        };
      }
      invoiceMap[key].reminder_count = (invoiceMap[key].reminder_count || 0) + 1;
      invoiceMap[key].is_reminder = true;
      if (!invoiceMap[key].amount && amount) invoiceMap[key].amount = amount;
    }
  }

  // ── Separate paid vs unpaid ───────────────────────────────────────────────
  const unpaid = [];
  const paid_invoices = [];

  for (const [key, inv] of Object.entries(invoiceMap)) {
    const invPaidByKey = paidSet.has(key);
    const invPaidByNum = inv.invoice_num && paidSet.has('::' + inv.invoice_num);
    if (invPaidByKey || invPaidByNum) {
      paid_invoices.push(inv);
    } else {
      unpaid.push(inv);
    }
  }

  // Sort unpaid: reminders first, then by days outstanding desc
  unpaid.sort((a, b) => {
    if (b.reminder_count !== a.reminder_count) return b.reminder_count - a.reminder_count;
    return daysSince(a.invoice_date) - daysSince(b.invoice_date) > 0 ? -1 : 1;
  });

  // ── Ramp vendor data ──────────────────────────────────────────────────────
  console.log('Fetching Ramp vendor data...');
  const rampVendors = await fetchRampVendors(DAYS);
  console.log('Ramp: ' + Object.keys(rampVendors).length + ' merchants');

  // Attach Ramp data to each unpaid invoice
  const vendorRampCache = {};
  for (const inv of unpaid) {
    if (!vendorRampCache[inv.vendor]) {
      vendorRampCache[inv.vendor] = rampDataForVendor(inv.vendor, rampVendors);
    }
    inv.ramp = vendorRampCache[inv.vendor] || null;
  }

  // Build ramp summary for known invoice vendors
  const ramp_vendor_summary = {};
  for (const [emailVendor] of Object.entries(EMAIL_TO_RAMP)) {
    const data = rampDataForVendor(emailVendor, rampVendors);
    if (data) ramp_vendor_summary[emailVendor] = data;
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  const confirmedTotal = unpaid.reduce((s, i) => s + (i.amount || 0), 0);
  const vendorSet = new Set(unpaid.map(i => i.vendor));

  const output = {
    ok: true,
    fetched_at: new Date().toISOString(),
    period_days: DAYS,
    totals: {
      unpaid_count: unpaid.length,
      unpaid_amount_confirmed: Math.round(confirmedTotal * 100) / 100,
      paid_count: paid_invoices.length,
      vendor_count: vendorSet.size,
    },
    unpaid,
    ramp_vendor_summary,
  };

  fs.writeFileSync(path.join(DATA_DIR, 'invoices.json'), JSON.stringify(output, null, 2));
  console.log('Saved data/invoices.json (' + unpaid.length + ' unpaid, ' + paid_invoices.length + ' paid)');
})().catch(e => { console.error(e.message); process.exit(1); });
