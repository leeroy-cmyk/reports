/**
 * PropertyMeld Spokane Lawn Service Scheduler
 * David Sanchez (53154) + Alexander Overall (61578)
 *
 * CANONICAL TEMPLATE = the week of Jun 15-19, 2026 (set by Lee Roy 2026-06-11).
 * Every future week is populated automatically by mirroring this template:
 *   - day-of-week + start time + duration are taken from the TEMPLATE (never drift),
 *   - the target week advances from the latest already-scheduled week (+7),
 *     so the clean reference week self-propagates forward indefinitely.
 *
 * Scope: ONLY recurring "Lawn service" melds assigned to David/Alexander.
 * One-offs like "Pressure wash exterior siding" (no recurring_meld, different brief)
 * are excluded automatically and never mirrored.
 */

const https = require('https');
const BASE = 'https://app.propertymeld.com', MGMT = '2975';
const DAVID_ID = 53154, ALEXANDER_ID = 61578;
const DRY_RUN = process.env.DRY_RUN === '1';

// recurring_meld_id -> { prop, day (1=Mon..5=Fri), startHr, startMin, durationHrs }
// Captured from the Jun 15-19, 2026 reference week.
const TEMPLATE = {
  // Monday
  161264: { prop:'v202', day:1, hr:8,  min:15, dur:2 },
  161265: { prop:'s129', day:1, hr:10, min:15, dur:2 },
  161266: { prop:'s300', day:1, hr:12, min:15, dur:2 },
  161267: { prop:'p705', day:1, hr:14, min:15, dur:1 },
  161270: { prop:'a210', day:1, hr:15, min:15, dur:1 },
  // Tuesday
  161271: { prop:'j312', day:2, hr:8,  min:15, dur:1 },
  161272: { prop:'a511', day:2, hr:9,  min:15, dur:1 },
  161276: { prop:'a916', day:2, hr:10, min:15, dur:1 },
  161277: { prop:'m221', day:2, hr:11, min:15, dur:1 },
  161278: { prop:'b101', day:2, hr:12, min:15, dur:1 },
  161279: { prop:'m608', day:2, hr:13, min:15, dur:1 },
  161280: { prop:'m405', day:2, hr:14, min:15, dur:1 },
  161281: { prop:'l912', day:2, hr:15, min:15, dur:1 },
  // Wednesday — re-sequenced 2026-06-18 to fit h731 at noon (Lee Roy: "move the schedule
  // out to make room"). Day now runs 8:00–18:00, no overlaps.
  161282: { prop:'w117', day:3, hr:8,  min:0, dur:2 },   // 8:00–10:00
  161284: { prop:'w226', day:3, hr:10, min:0, dur:2 },   // 10:00–12:00
  // h731 at noon — two PM recurrences (163904 old bi-weekly, 179920 current) both point here.
  163904: { prop:'h731', day:3, hr:12, min:0, dur:2 },   // 12:00–14:00
  179920: { prop:'h731', day:3, hr:12, min:0, dur:2 },
  161286: { prop:'e328', day:3, hr:14, min:0, dur:2 },   // 14:00–16:00 (moved out)
  161289: { prop:'c302', day:3, hr:16, min:0, dur:2 },   // 16:00–18:00 (moved out)
  // Thursday
  161291: { prop:'c313',     day:4, hr:8,  min:15, dur:2 },
  162927: { prop:'o155-Oak', day:4, hr:10, min:15, dur:2 },
  // Friday
  167333: { prop:'k104',     day:5, hr:8,  min:15, dur:2 },
  164381: { prop:'k308',     day:5, hr:10, min:15, dur:2 },
};

async function httpreq(method, urlStr, headers, bodyStr) {
  return new Promise((res,rej) => {
    const u = new URL(urlStr);
    const r = https.request({hostname:u.hostname,path:u.pathname+u.search,method,headers:headers||{}}, resp => {
      let b=''; resp.on('data',d=>b+=d); resp.on('end',()=>res({status:resp.statusCode,headers:resp.headers,body:b}));
    }).on('error',rej);
    if(bodyStr) r.write(bodyStr); r.end();
  });
}

async function login() {
  let jar = {};
  function add(h) { if(!h||!h['set-cookie'])return; h['set-cookie'].forEach(c=>{const kv=c.split(';')[0];const eq=kv.indexOf('=');if(eq>0)jar[kv.slice(0,eq).trim()]=kv.slice(eq+1);}); }
  const sc = () => Object.entries(jar).map(([k,v])=>k+'='+v).join('; ');
  const r1 = await httpreq('GET', BASE+'/login/?next=/', {'User-Agent':'Mozilla/5.0'});
  add(r1.headers);
  const csrf1=(r1.body.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/) || [])[1];
  const bd = new URLSearchParams({csrfmiddlewaretoken:csrf1,email:process.env.PROPERTYMELD_EMAIL,password:process.env.PROPERTYMELD_PASSWORD}).toString();
  const r2 = await httpreq('POST', BASE+'/login/?next=/', {'User-Agent':'Mozilla/5.0','Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(bd),'Referer':BASE+'/login/?next=/','Cookie':sc()}, bd);
  add(r2.headers);
  const r3 = await httpreq('GET', BASE+'/'+MGMT+'/m/'+MGMT+'/dashboard/', {'User-Agent':'Mozilla/5.0','Cookie':sc()});
  add(r3.headers);
  const csrfMatch = r3.body.match(/window\.PM\.csrf_token\s*=\s*"([^"]+)"/);
  return {sc, csrf: csrfMatch ? csrfMatch[1] : ''};
}

async function api(method, path, sc, csrf, body) {
  const bodyStr = body != null ? JSON.stringify(body) : null;
  const h = {'User-Agent':'Mozilla/5.0','Cookie':sc(),'X-CSRFToken':csrf,'Accept':'application/json','Referer':BASE+'/'+MGMT+'/m/'+MGMT+'/'};
  if(bodyStr){h['Content-Type']='application/json';h['Content-Length']=Buffer.byteLength(bodyStr);}
  return httpreq(method, BASE+'/'+MGMT+'/m/'+MGMT+path, h, bodyStr);
}

const pad = n => String(n).padStart(2,'0');
function ymd(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
function localDate() {
  const pdt = new Date(new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles'}));
  return pdt.getFullYear()+'-'+pad(pdt.getMonth()+1)+'-'+pad(pdt.getDate());
}
// Monday (Date obj, noon PDT) of the calendar week containing dateStr
function mondayOf(dateStr){
  const d = new Date(dateStr+'T12:00:00-07:00');
  const dow = d.getDay();
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  return d;
}
// Date string for template day (1=Mon..5=Fri) within the week whose Monday is `monday`
function dateForDay(monday, day){
  const d = new Date(monday);
  d.setDate(d.getDate() + (day - 1));
  return ymd(d);
}
function slotStr(date, hr, min, dur) {
  const endMin = hr*60 + min + Math.round(dur*60);
  return {
    dtstart: `${date}T${pad(hr)}:${pad(min)}:00-07:00`,
    dtend:   `${date}T${pad(Math.floor(endMin/60))}:${pad(endMin%60)}:00-07:00`,
  };
}
const fmt = iso => new Date(iso).toLocaleString('en-US',{
  timeZone:'America/Los_Angeles',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'
});

async function main() {
  const {sc, csrf} = await login();
  const today = localDate();
  let scheduled = 0, skipped = 0, unknown = 0;

  // 1. Open lawn melds assigned to David/Alexander (these are candidates to schedule)
  const statuses = ['PENDING_ASSIGNMENT','PENDING_MORE_MANAGEMENT_AVAILABILITY'];
  let melds = [];
  for (const s of statuses) {
    let offset = 0;
    while(true) {
      const r = await api('GET', '/api/melds/?limit=200&offset='+offset+'&status='+s, sc, csrf);
      if (r.status !== 200) break;
      const d = JSON.parse(r.body);
      melds.push(...(d.results||[]).filter(m => {
        const isLawn = /lawn service/i.test(m.brief_description||'');
        const isDA = m.in_house_servicers?.some(s=>s.agent?.id===DAVID_ID||s.agent?.id===ALEXANDER_ID);
        return isLawn && isDA;
      }));
      if (!d.next||!d.results?.length) break;
      offset += 200;
    }
  }
  const seen = new Set(); melds = melds.filter(m=>{if(seen.has(m.id))return false;seen.add(m.id);return true;});

  // 2. Build latest-scheduled-sibling map by recurring_meld (used only to advance the WEEK;
  //    day/time/duration always come from TEMPLATE so they never drift).
  const latestSib = {}; // recurId -> latest dtstart (YYYY-MM-DD...) string
  function consider(m){
    const recurId = m.recurring_meld; if(!recurId) return;
    const ev = m.managementappointment?.find(a=>a.availability_segment?.event)?.availability_segment?.event;
    if(!ev) return;
    if(!latestSib[recurId] || ev.dtstart > latestSib[recurId]) latestSib[recurId] = ev.dtstart;
  }
  melds.forEach(consider);
  for (const st of ['PENDING_COMPLETION','PENDING_MORE_MANAGEMENT_AVAILABILITY']) {
    let offset = 0;
    while(true){
      const r = await api('GET','/api/melds/?limit=200&offset='+offset+'&status='+st, sc, csrf);
      if(r.status!==200) break;
      const d = JSON.parse(r.body);
      (d.results||[]).filter(m=>/lawn service/i.test(m.brief_description||'')).forEach(consider);
      if(!d.next||!d.results?.length) break;
      offset += 200;
    }
  }

  // 3. Schedule each unscheduled lawn meld onto the template
  const unscheduled = melds.filter(m => !m.managementappointment?.find(a=>a.availability_segment?.event));
  console.log('Lawn melds (open):', melds.length, '| Unscheduled:', unscheduled.length, DRY_RUN?'| DRY_RUN':'');

  // Next week's Monday relative to today — never schedule earlier than this
  const nextWeekMon = mondayOf(today); nextWeekMon.setDate(nextWeekMon.getDate()+7);

  for (const m of unscheduled) {
    const recurId = m.recurring_meld;
    const propObj = (m.unit && m.unit.prop) ? m.unit.prop : m.prop;
    const propName = propObj?.property_name || '?';
    const tmpl = recurId ? TEMPLATE[recurId] : null;

    if (!tmpl) {
      console.log('UNKNOWN: no template for', m.reference_id, '| prop:', propName, '| recurring_meld:', recurId, '(add it to TEMPLATE if it should be on the route)');
      unknown++;
      continue;
    }

    // Target week = week after the latest already-scheduled instance of this recurrence,
    // but never before next week from today.
    let targetMon;
    if (latestSib[recurId]) {
      targetMon = mondayOf(latestSib[recurId].slice(0,10));
      targetMon.setDate(targetMon.getDate()+7);
    } else {
      targetMon = new Date(nextWeekMon);
    }
    while (targetMon < nextWeekMon) targetMon.setDate(targetMon.getDate()+7);

    const date = dateForDay(targetMon, tmpl.day);
    const {dtstart, dtend} = slotStr(date, tmpl.hr, tmpl.min, tmpl.dur);
    process.stdout.write(`${m.reference_id} [${propName}] → ${fmt(dtstart)} (${tmpl.dur}h) ... `);

    if (DRY_RUN) { console.log('(dry-run)'); scheduled++; continue; }

    const r = await api('PATCH', '/api/melds/'+m.id+'/accept/', sc, csrf, {
      mark_scheduled: true, segments_to_keep: [],
      management_availability_segments: [{ event: { dtstart, dtend } }]
    });
    if (r.status >= 200 && r.status < 300) {
      console.log('OK'); scheduled++;
      // record so siblings within this run advance correctly
      if(!latestSib[recurId] || dtstart > latestSib[recurId]) latestSib[recurId] = dtstart;
    } else if (r.status === 400 && r.body.includes('already been started')) {
      const r2 = await api('PATCH', '/api/melds/'+m.id+'/segments/reschedule/', sc, csrf, {
        mark_scheduled: true, segments_to_keep: [], new_segments: [{ event: { dtstart, dtend } }]
      });
      console.log(r2.status < 300 ? 'OK (reschedule)' : 'FAIL '+r2.status);
      if (r2.status < 300) scheduled++; else skipped++;
    } else {
      console.log('FAIL', r.status, r.body.slice(0,80)); skipped++;
    }
  }

  console.log(`\nDone: ${scheduled} scheduled, ${skipped} skipped, ${unknown} unknown templates`);
  if (unknown > 0) console.log('NOTE: Unknown melds need their recurring_meld IDs added to the TEMPLATE map');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
