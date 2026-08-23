'use strict';
// Generates reports/wages.html — team hourly rates + 50% markup + billable total.
// Rates mirror WAGE_MAP in reports/qbtime_report.html (line ~197). Upstream source of truth is the
// Google Sheet "team wages v6" (12IR2Oqnt9sM2SHOm4eJ0YfhxzM0lqbrXfMryb5eWgwo).
// Markup = wage * 0.5 ; Total (billable) = wage * 1.5.
const fs = require('fs');

const TEAM = [
  // name,               dept,                          region,       wage,  status
  ['Lee Roy Phillips',  'Maint & Construction Mgr',     'GEG',        50.00, 'mgr'],
  ['Lawrence Uttke',    'Projects',                     'All',        34.00, 'prj'],
  ['Scott Higley',      'Turn',                         'Spokane',    31.99, 'gone'],
  ['Wade Hippen',       'Repairs',                      'Spokane',    28.44, 'gone'],
  ['Margarito Saldana', 'Turn',                         'Tri-Cities', 28.40, 'turn'],
  ['Jared Miller',      'Repairs',                      'Tri-Cities', 28.09, 'rep'],
  ['Jonas Hoard',       'Turn',                         'Tacoma',     27.00, 'turn'],
  ['Armani Mitchell',   'Turn',                         'Tacoma',     27.00, 'turn'],
  ['Isaac Chavez',      'Repairs',                      'Tri-Cities', 27.00, 'rep'],
  ['Ron Cramer',        'Turn',                         'Spokane',    25.75, 'turn'],
  ['David Sanchez',     'Grounds',                      'Spokane',    25.50, 'grd'],
  ['Micheal Magoon',    'Turn',                         'Spokane',    25.00, 'turn'],
  ['Justin Gutierrez',  'Repairs',                      'Spokane',    25.00, 'rep'],
  ['Jacob Jett',        'Repairs',                      'Spokane',    25.00, 'rep'],
  ['Reynaldo Leonides', 'Grounds',                      'Tri-Cities', 25.00, 'grd'],
  ['Bryon McQuaid',     'Turn',                         'Tri-Cities', 25.00, 'gone'],
  ['Jaxson Lakins',     'Repairs',                      'Tri-Cities', 24.00, 'rep'],
  ['Ryan Robson',       'Turn',                         'Tri-Cities', 23.00, 'turn'],
  ['James Dunlap',      'Turn',                         'Tri-Cities', 23.00, 'turn'],
  ['Hannah Deckard',    'Grounds',                      'Tri-Cities', 22.00, 'grd'],
];

const MARKUP = 0.5;
// Work in integer cents and round the markup half-up, then define total = wage + markup. Two reasons:
// binary floats make toFixed round 31.99*1.5 = 47.985 DOWN to 47.98, and computing the total
// independently lets the printed columns disagree (31.99 + 15.99 showing a 47.98 total). Deriving the
// total from the rounded markup guarantees Hourly + Markup == Total on every row.
const cents = w => Math.round(w * 100);
const mC = w => Math.round(cents(w) * MARKUP);          // markup, in cents (half-up)
const m = w => mC(w) / 100;                             // markup amount
const t = w => (cents(w) + mC(w)) / 100;                // billable total
const $ = n => '$' + n.toFixed(2);

const active   = TEAM.filter(r => r[4] !== 'gone');
const departed = TEAM.filter(r => r[4] === 'gone');
// "Field" = active crew only, excluding the manager (Lee Roy)
const field    = active.filter(r => r[4] !== 'mgr').map(r => r[3]);
const avg      = field.reduce((a, b) => a + b, 0) / field.length;

const LBL = { turn:'Turn', rep:'Repairs', grd:'Grounds', prj:'Projects', mgr:'Maint & Construction Mgr' };
const rows = TEAM.map(([name, dept, region, wage, st]) => {
  const gone = st === 'gone';
  const badge = gone ? `<span class="b out">${dept} &middot; departed</span>`
                     : `<span class="b ${st}">${LBL[st] || dept}</span>`;
  return `          <tr${gone ? ' class="gone"' : ''}><td class="nm">${name}</td><td>${badge}</td><td>${region}</td>`
       + `<td class="n">${$(wage)}</td><td class="n mk">${$(m(wage))}</td><td class="n tot">${$(t(wage))}</td></tr>`;
}).join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<script src="auth.js"></script>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Team Wages</title>
<style>
  :root{ --bg:#f4f6f9; --card:#fff; --navy:#1a5276; --blue:#2e86c1; --line:#e3e8ee; --txt:#2c3e50; --mut:#7f8c9a; }
  *{box-sizing:border-box}
  body{margin:0;padding:28px 20px 60px;background:var(--bg);color:var(--txt);
       font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
  .wrap{max-width:1060px;margin:0 auto}
  h1{margin:0 0 4px;font-size:26px;color:var(--navy);letter-spacing:-.2px}
  .sub{color:var(--mut);font-size:13px;margin-bottom:22px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:24px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;
        box-shadow:0 1px 2px rgba(26,82,118,.05)}
  .card .k{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--mut);margin-bottom:6px}
  .card .v{font-size:23px;font-weight:600;color:var(--navy)}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;
         box-shadow:0 1px 2px rgba(26,82,118,.05);margin-bottom:22px}
  .panel h2{margin:0;padding:14px 18px;font-size:15px;color:var(--navy);border-bottom:1px solid var(--line);background:#fbfcfd}
  .scroll{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th{text-align:left;padding:10px 18px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;
     color:var(--mut);border-bottom:1px solid var(--line);white-space:nowrap;background:#fbfcfd}
  th.r{text-align:right}
  td{padding:10px 18px;border-bottom:1px solid #f1f4f7;white-space:nowrap}
  tr:last-child td{border-bottom:none}
  tbody tr:hover td{background:#f8fafc}
  .n{font-variant-numeric:tabular-nums;text-align:right}
  .mk{color:var(--mut)}
  .tot{font-weight:600;color:var(--navy);background:#f7fafd}
  td.n:first-of-type{font-weight:600}
  .gone td{color:#a9b4bf}
  .gone .nm{text-decoration:line-through}
  .gone .tot{color:#a9b4bf;background:#fafbfc}
  .b{display:inline-block;padding:2px 9px;border-radius:11px;font-size:11px;font-weight:600}
  .turn{background:#e8f1fa;color:#1a5276}
  .rep{background:#eaf6ef;color:#1e7b45}
  .grd{background:#fdf3e3;color:#8a5a12}
  .prj{background:#f0eafa;color:#5b3a91}
  .mgr{background:#e9edf1;color:#465b6d}
  .out{background:#fdecec;color:#a33}
  .note{background:#fff8e6;border:1px solid #f2e0b0;border-left:4px solid #e0a92c;
        border-radius:8px;padding:14px 18px;margin-bottom:18px;font-size:13.5px}
  .note b{color:#8a5a12}
  .note ul{margin:8px 0 0;padding-left:20px}
  .note li{margin-bottom:6px}
  .src{padding:14px 18px;color:var(--mut);font-size:12px;line-height:1.7}
  code{background:#eef2f6;padding:1px 5px;border-radius:4px;font-size:12px}
</style>
</head>
<body>
<div class="wrap">

  <h1>Team Wages</h1>
  <div class="sub">Hourly cost, 50% markup, and billable total &middot; generated 2026-07-29</div>

  <div class="cards">
    <div class="card"><div class="k">Entries</div><div class="v">${TEAM.length}</div></div>
    <div class="card"><div class="k">Active</div><div class="v">${active.length}</div></div>
    <div class="card"><div class="k">Departed</div><div class="v">${departed.length}</div></div>
    <div class="card"><div class="k">Field avg cost</div><div class="v">${$(avg)}</div></div>
    <div class="card"><div class="k">Field avg billable</div><div class="v">${$(t(avg))}</div></div>
  </div>

  <div class="note">
    <b>Notes</b>
    <ul>
      <li><b>Markup</b> = hourly &times; 50%. <b>Total</b> = hourly &times; 1.5 &mdash; the billable rate for
          property hours. This markup is <b>not yet applied in the Budget vs Actuals report</b>, which still
          costs labor at raw wage; these totals are the intended billable rates, not what the report charges today.</li>
      <li><b>Two active techs are still missing from the report's <code>WAGE_MAP</code>: Jacob Jett
          (62740, Spokane repairs, hired 2026-07-20 replacing Wade Hippen) and Alexander (61578, Spokane
          lawn).</b> The report skips any timecard whose employee isn't in that map
          (<code>if (!emp) return;</code>), so their hours are dropped from labor cost entirely rather than
          costed at a default. Jacob's rate is now known ($25.00) and can be added; Alexander's is not.</li>
      <li><b>Scott Higley's departure leaves the Spokane turn crew without its supervisor</b> &mdash; Ron and
          Magoon both report to Scott in the org chart, and Scott reported to Chris. Worth confirming who
          covers that, and CLAUDE.md's roster still lists him.</li>
      <li>Departed (struck through) are kept for historical timecard costing; they draw no new hours.</li>
    </ul>
  </div>

  <div class="panel">
    <h2>Hourly rates &mdash; highest to lowest</h2>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>Name</th><th>Department</th><th>Region</th>
          <th class="r">Hourly</th><th class="r">Markup 50%</th><th class="r">Total (1.5&times;)</th>
        </tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h2>Source &amp; caveat</h2>
    <div class="src">
      Rates mirror <code>WAGE_MAP</code> in <code>reports/qbtime_report.html</code> (line ~197) &mdash; the values
      actually used to cost QuickBooks Time labor in the Budget vs Actuals report.<br>
      Upstream source of truth is the Google Sheet <b>&ldquo;team wages v6&rdquo;</b>
      (<code>12IR2Oqnt9sM2SHOm4eJ0YfhxzM0lqbrXfMryb5eWgwo</code>). <b>No Google Sheets tool was connected when
      this was generated, so the rates were NOT re-verified against that sheet</b> &mdash; if any changed there
      since the last sync, both the report and this page are using the old number.<br>
      Field avg excludes Lee Roy and the ${departed.length} departed techs (n=${field.length}).
      Regenerate with <code>node reports/gen-wages.js</code>.
    </div>
  </div>

</div>
</body>
</html>
`;

fs.writeFileSync('C:/Users/lrphi/reports/wages.html', html);
console.log(`wrote wages.html — ${TEAM.length} entries (${active.length} active, ${departed.length} departed)`);
console.log(`field avg cost ${$(avg)} -> billable ${$(t(avg))} (n=${field.length})`);
console.log('\nname                 hourly   markup   total');
TEAM.forEach(([n,,,w,st]) => console.log(
  `${n.padEnd(20)} ${$(w).padStart(7)} ${$(m(w)).padStart(8)} ${$(t(w)).padStart(8)}${st==='gone'?'   (departed)':''}`));
