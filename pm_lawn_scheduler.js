/**
 * PropertyMeld Spokane Lawn Service Scheduler
 * David Sanchez (53154) + Alexander Overall (61578)
 * Matches the template week of Jun 8-12, 2026.
 * When new recurring "Lawn service" melds appear, schedules them
 * on the correct day + time based on their recurring_meld ID.
 */

const https = require('https');
const BASE = 'https://app.propertymeld.com', MGMT = '2975';
const DAVID_ID = 53154, ALEXANDER_ID = 61578;

// Template: recurring_meld_id -> { dayOfWeek (0=Sun,1=Mon,...), startHr, startMin, durationHrs }
// Extracted from the Jun 8-12 reference week.
const TEMPLATE = {
  161264: { prop:'v202',   day:1, hr:8,  min:15, dur:1 },   // Mon 8:15 1h
  161265: { prop:'s129',   day:1, hr:9,  min:15, dur:2 },   // Mon 9:15 2h
  161266: { prop:'s300',   day:1, hr:11, min:15, dur:2 },   // Mon 11:15 2h
  161267: { prop:'p705',   day:1, hr:13, min:15, dur:2 },   // Mon 13:15 2h
  161270: { prop:'a210',   day:1, hr:15, min:15, dur:1 },   // Mon 15:15 1h
  161271: { prop:'j312',   day:2, hr:8,  min:15, dur:1 },   // Tue 8:15 1h
  161272: { prop:'a511',   day:2, hr:9,  min:15, dur:1 },   // Tue 9:15 1h
  161276: { prop:'a916',   day:2, hr:10, min:15, dur:1 },   // Tue 10:15 1h
  161277: { prop:'m221',   day:2, hr:11, min:15, dur:1 },   // Tue 11:15 1h
  161278: { prop:'b101',   day:2, hr:12, min:15, dur:1 },   // Tue 12:15 1h
  161279: { prop:'m608',   day:2, hr:13, min:15, dur:1 },   // Tue 13:15 1h
  161280: { prop:'m405',   day:2, hr:14, min:15, dur:1 },   // Tue 14:15 1h
  161281: { prop:'l912',   day:2, hr:15, min:15, dur:1 },   // Tue 15:15 1h
  161282: { prop:'w117',   day:3, hr:10, min:15, dur:1 },   // Wed 10:15 1h
  161284: { prop:'w226',   day:3, hr:11, min:15, dur:1 },   // Wed 11:15 1h
  161286: { prop:'e328',   day:3, hr:12, min:15, dur:2 },   // Wed 12:15 2h
  161291: { prop:'c313',   day:4, hr:8,  min:15, dur:2 },   // Thu 8:15 2h
  161289: { prop:'c302',   day:4, hr:10, min:15, dur:2 },   // Thu 10:15 2h
  167333: { prop:'k104',   day:5, hr:8,  min:15, dur:2 },   // Fri 8:15 2h
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

// Get next occurrence of a given day-of-week on or after a reference date, in the next N weeks
function nextOccurrence(targetDay, afterDate, weeksAhead) {
  // Find the Monday of the week that is weeksAhead weeks after the afterDate week
  const ref = new Date(afterDate + 'T12:00:00-07:00');
  // Start from next day
  const start = new Date(ref);
  start.setDate(start.getDate() + 1);
  // Move forward until we hit targetDay
  for (let i = 0; i < 14; i++) {
    if (start.getDay() === targetDay) {
      const ds = start.getFullYear()+'-'+String(start.getMonth()+1).padStart(2,'0')+'-'+String(start.getDate()).padStart(2,'0');
      return ds;
    }
    start.setDate(start.getDate() + 1);
  }
  return null;
}

function slotStr(date, hr, min, dur) {
  const pad = n => String(n).padStart(2,'0');
  const endMin = hr*60 + min + Math.round(dur*60);
  return {
    dtstart: `${date}T${pad(hr)}:${pad(min)}:00-07:00`,
    dtend:   `${date}T${pad(Math.floor(endMin/60))}:${pad(endMin%60)}:00-07:00`,
  };
}

const fmt = iso => new Date(iso).toLocaleString('en-US',{
  timeZone:'America/Los_Angeles',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'
});

function localDate() {
  const pdt = new Date(new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles'}));
  return pdt.getFullYear()+'-'+String(pdt.getMonth()+1).padStart(2,'0')+'-'+String(pdt.getDate()).padStart(2,'0');
}

async function main() {
  const {sc, csrf} = await login();
  const today = localDate();
  let scheduled = 0, skipped = 0, unknown = 0;

  // Get all open lawn service melds assigned to David or Alexander
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

  // Filter to unscheduled ones only
  const unscheduled = melds.filter(m => !m.managementappointment?.find(a=>a.availability_segment?.event));
  console.log('Lawn service melds assigned to David/Alexander:', melds.length, '| Unscheduled:', unscheduled.length);

  for (const m of unscheduled) {
    const recurId = m.recurring_meld;
    const tmpl = recurId ? TEMPLATE[recurId] : null;

    if (!tmpl) {
      // Unknown recurring rule — log and skip
      const propObj = (m.unit && m.unit.prop) ? m.unit.prop : m.prop;
      console.log('UNKNOWN template for', m.reference_id, '| prop:', propObj?.property_name, '| recurring_meld:', recurId);
      unknown++;
      continue;
    }

    // Find the next occurrence of the target day-of-week
    const targetDate = nextOccurrence(tmpl.day, today, 1);
    if (!targetDate) { console.log('Could not find date for', m.reference_id); skipped++; continue; }

    const {dtstart, dtend} = slotStr(targetDate, tmpl.hr, tmpl.min, tmpl.dur);

    process.stdout.write(`${m.reference_id} [${tmpl.prop}] → ${fmt(dtstart)} (${tmpl.dur}h) ... `);

    // Schedule via accept endpoint
    const r = await api('PATCH', '/api/melds/'+m.id+'/accept/', sc, csrf, {
      mark_scheduled: true,
      segments_to_keep: [],
      management_availability_segments: [{ event: { dtstart, dtend } }]
    });
    if (r.status >= 200 && r.status < 300) {
      console.log('OK');
      scheduled++;
    } else if (r.status === 400 && r.body.includes('already been started')) {
      const r2 = await api('PATCH', '/api/melds/'+m.id+'/segments/reschedule/', sc, csrf, {
        mark_scheduled: true, segments_to_keep: [],
        new_segments: [{ event: { dtstart, dtend } }]
      });
      console.log(r2.status < 300 ? 'OK (reschedule)' : 'FAIL '+r2.status);
      if (r2.status < 300) scheduled++; else skipped++;
    } else {
      console.log('FAIL', r.status, r.body.slice(0,80));
      skipped++;
    }
  }

  console.log(`\nDone: ${scheduled} scheduled, ${skipped} skipped, ${unknown} unknown templates`);
  if (unknown > 0) console.log('NOTE: Unknown melds need their recurring_meld IDs added to the TEMPLATE map');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
