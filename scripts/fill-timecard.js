'use strict';
const https = require('https');

const TOKEN = process.env.QBT_TOKEN;
if (!TOKEN) { console.error('QBT_TOKEN not set'); process.exit(1); }

const USER_ID = 5249464, JOBCODE_ID = 29656266;
// ⛔ CLASS IS ALWAYS 'r203:Turn - Admin' (Lee Roy 2026-08-16: "im no longer working on R&M or grounds
// admin, so all of my time should go to Turn admin"). This file was still writing the bare default
// 'r203' for BOTH fields, so every entry the nightly cron created was mis-classed — 49 entries /
// ~48h over 08-17..08-21 alone. Custom-field values are NAMES, not ids: the class must read exactly
// 'r203:Turn - Admin', matching what qbt-recode-write-*.js writes.
// PROPERTY stays 'r203' here deliberately — the billable half is spend-weighted from Ramp turn spend,
// which this cron cannot reach. The periodic recode assigns it. A FILLED DAY IS NOT A FINISHED DAY:
// fill -> re-note from the calendar -> recode class+property.
const ADMIN_CLASS = 'r203:Turn - Admin';
const NO_PROPERTY = 'r203';
const CF = { '25056': ADMIN_CLASS, '25068': NO_PROPERTY };
const month = new Date().getUTCMonth();
const TZ = (month >= 3 && month <= 9) ? '-07:00' : '-08:00'; // PDT Apr-Oct, PST Nov-Mar
const sleep = ms => new Promise(r => setTimeout(r, ms));

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'rest.tsheets.com', path, method,
      headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Parse: ' + d.slice(0, 200))); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Local date in Lee Roy's timezone
function localToday() {
  const off = TZ === '-07:00' ? -7 : -8;
  return new Date(Date.now() + off * 3600000).toISOString().slice(0, 10);
}

function prevWeekday(d) {
  const dt = new Date(d + 'T12:00:00Z');
  do { dt.setUTCDate(dt.getUTCDate() - 1); } while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6);
  return dt.toISOString().slice(0, 10);
}

// Weighted random — biased toward short entries (realistic timecard)
const MAX_PIECE_MIN = 115;   // strictly under 2h
function randSize(remaining) {
  if (remaining <= 30) return remaining;
  const r = Math.random();
  let s;
  if (r < 0.40) s = 20 + Math.floor(Math.random() * 21);   // 20-40 min  (40%)
  else if (r < 0.72) s = 41 + Math.floor(Math.random() * 35);  // 41-75 min  (32%)
  else if (r < 0.92) s = 76 + Math.floor(Math.random() * 30);  // 76-105 min (20%)
  else s = 106 + Math.floor(Math.random() * 10);               // 106-115 min (8%)
  // ⛔ 115, never 120: an entry of exactly 2.00h breaks the rule (Lee Roy 2026-08-03 — "they should
  // be axactly less than 2 hrs"). The old cap of 120 could land precisely on it.
  return Math.min(s, MAX_PIECE_MIN, remaining);
}

const NOTES = {
  6:  ['Morning review and property meld', 'Early email triage and WO review'],
  7:  ['Morning review; urgent items', 'Property meld updates; EA report'],
  8:  ['LR:FS morning meeting', 'MGR meeting; team planning'],
  9:  ['Tacoma turn meeting', 'LR/LU projects check-in'],
  10: ['WO prioritization and vendor follow-up', 'Tri-Cities turn meeting'],
  11: ['Accounting daily; invoice review', 'Turn ops oversight'],
  12: ['Turn planning and documentation', 'Budget and cost review'],
  13: ['W225 focus time — project docs', 'Contractor coordination'],
  14: ['CapEx planning and cost review', 'Property inspection follow-up'],
  15: ['Grounds and maintenance coordination', 'Focus time — ops planning'],
  16: ['Invoice approval; vendor follow-up', 'End of day WO status review'],
  17: ['EOD reporting and notes', 'Admin closeout'],
};
function noteFor(startMin) {
  const h = Math.floor(startMin / 60);
  const pool = NOTES[Math.min(17, Math.max(6, h))];
  return pool[Math.floor(Math.random() * pool.length)];
}

const tMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const minT = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const iso  = (d, hm) => d + 'T' + hm + ':00' + TZ;

function makeEntry(date, s, e, note) {
  return { user_id: USER_ID, jobcode_id: JOBCODE_ID, type: 'regular', date, start: iso(date, s), end: iso(date, e), notes: note, customfields: CF };
}

function splitRange(date, startStr, endStr) {
  let cur = tMin(startStr), end = tMin(endStr);
  const out = [];
  while (cur < end) {
    const sz = randSize(end - cur);
    out.push(makeEntry(date, minT(cur), minT(cur + sz), noteFor(cur)));
    cur += sz;
  }
  return out;
}

function computeGaps(existing, startMin, endMin, lunchS, lunchE) {
  const blocked = [
    ...existing.filter(t => t.start && t.end).map(t => ({ s: tMin(t.start.slice(11, 16)), e: tMin(t.end.slice(11, 16)) })),
    { s: lunchS, e: lunchE },
  ].sort((a, b) => a.s - b.s);
  const merged = [];
  for (const b of blocked) {
    if (merged.length && b.s <= merged[merged.length - 1].e)
      merged[merged.length - 1].e = Math.max(merged[merged.length - 1].e, b.e);
    else merged.push({ ...b });
  }
  const out = []; let cur = startMin;
  for (const b of merged) {
    if (b.s > cur) out.push({ s: cur, e: Math.min(b.s, endMin) });
    cur = Math.max(cur, b.e);
  }
  if (cur < endMin) out.push({ s: cur, e: endMin });
  return out.filter(g => g.e - g.s >= 15);
}

async function fetchEntries(date) {
  const r = await api('GET', '/api/v1/timesheets?start_date=' + date + '&end_date=' + date + '&user_ids=' + USER_ID + '&on_the_clock=no&per_page=200');
  return Object.values(r.results?.timesheets || {});
}

async function deleteEntries(ids) {
  if (!ids.length) return;
  await api('DELETE', '/api/v1/timesheets?ids=' + ids.join(','));
  await sleep(200);
}

async function createEntries(entries) {
  if (!entries.length) return 0;
  const r = await api('POST', '/api/v1/timesheets', { data: entries });
  const vals = Object.values(r.results?.timesheets || {});
  const bad = vals.filter(t => t._status_code && t._status_code !== 200);
  if (bad.length) console.log('  WARN:', bad[0]._status_extra?.slice(0, 120));
  return vals.filter(t => !t._status_code || t._status_code === 200).length;
}

async function processDay(date, label, fillGaps) {
  const all = await fetchEntries(date); await sleep(200);

  // Fix oversized entries (>2hr)
  const over = all.filter(t => t.duration > 7200);
  let deleted = 0, created = 0;
  if (over.length) {
    await deleteEntries(over.map(t => t.id)); deleted = over.length;
    const reps = over.flatMap(t => splitRange(date, t.start.slice(11, 16), t.end.slice(11, 16)));
    created += await createEntries(reps); await sleep(200);
    console.log(label + ': fixed ' + over.length + ' oversized → ' + created + ' replacements');
  }

  if (!fillGaps) {
    if (!over.length) console.log(label + ': ' + all.length + ' entries, no oversized — skip');
    return;
  }

  // Fill gaps
  const current = over.length ? await fetchEntries(date) : all; await sleep(200);
  const dayStart = 390 + Math.floor(Math.random() * 31); // 6:30–7:00
  const dayEnd   = 990 + Math.floor(Math.random() * 61); // 16:30–17:30
  const lunchS   = 720 + Math.floor(Math.random() * 21); // 12:00–12:20
  const lunchE   = lunchS + 25 + Math.floor(Math.random() * 20); // 25–45 min lunch

  const gapList = computeGaps(current, dayStart, dayEnd, lunchS, lunchE);
  console.log(label + ': ' + current.length + ' existing, ' + gapList.length + ' gaps (window ' + minT(dayStart) + '–' + minT(dayEnd) + ', lunch ' + minT(lunchS) + '–' + minT(lunchE) + ')');

  const newEntries = gapList.flatMap(g => splitRange(date, minT(g.s), minT(g.e)));
  if (newEntries.length) {
    const n = await createEntries(newEntries); created += n;
    console.log('  Filled ' + n + ' entries');
  } else {
    console.log('  Day fully covered');
  }

  const final = await fetchEntries(date);
  const totalH = final.reduce((s, t) => s + t.duration / 3600, 0);
  const maxD = final.length ? Math.max(...final.map(t => t.duration)) : 0;
  console.log('  Total: ' + totalH.toFixed(1) + 'h | deleted:' + deleted + ' created:' + created + (maxD > 7200 ? ' ⚠ OVER-2HR' : ''));
}

(async () => {
  const today = localToday();
  console.log('QBT fill | today=' + today + ' tz=' + TZ);

  // Build list of past 5 weekdays + today
  const days = [];
  const dt = new Date(today + 'T12:00:00Z');
  while (days.length < 6) {
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6) days.unshift(dt.toISOString().slice(0, 10));
    dt.setUTCDate(dt.getUTCDate() - 1);
  }

  // Fetch all entries for the window with pagination
  let page = 1, allSheets = {};
  while (true) {
    const r = await api('GET', '/api/v1/timesheets?start_date=' + days[0] + '&end_date=' + today + '&user_ids=' + USER_ID + '&on_the_clock=no&per_page=200&page=' + page);
    Object.assign(allSheets, r.results?.timesheets || {});
    if (!r.more) break;
    page++; await sleep(150);
  }
  const hoursByDate = {};
  for (const t of Object.values(allSheets)) {
    hoursByDate[t.date] = (hoursByDate[t.date] || 0) + t.duration / 3600;
  }

  for (const d of days) {
    const h = hoursByDate[d] || 0;
    const isToday = d === today;
    const label = (isToday ? 'Today' : d) + ' (' + h.toFixed(1) + 'h)';
    if (h >= 7 && !isToday) { console.log(label + ': OK — skip'); continue; }
    await processDay(d, label, true);
    await sleep(300);
  }
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
