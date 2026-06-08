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

// Get the date for targetDay in the NEXT calendar week after today.
// "Next week" = the week starting the Monday after the current week.
// This ensures recurring melds always land on the same relative day next week,
// mirroring the current week's schedule exactly (+7 days).
function nextOccurrence(targetDay, afterDate, weeksAhead) {
  const ref = new Date(afterDate + 'T12:00:00-07:00');
  // Find the Monday of the current week
  const dayOfWeek = ref.getDay(); // 0=Sun, 1=Mon, ...
  const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(ref);
  monday.setDate(monday.getDate() + daysToMonday);
  // Next week's Monday = +7 days
  monday.setDate(monday.getDate() + 7);
  // targetDay offset from Monday: Mon=1 → 0, Tue=2 → 1, ... Sun=0 → 6
  const offset = targetDay === 0 ? 6 : targetDay - 1;
  monday.setDate(monday.getDate() + offset);
  const ds = monday.getFullYear()+'-'+String(monday.getMonth()+1).padStart(2,'0')+'-'+String(monday.getDate()).padStart(2,'0');
  return ds;
  // (unreachable fallback)
  for (let i = 0; i < 14; i++) {
    if (monday.getDay() === targetDay) {
      return ds;
    }
    monday.setDate(monday.getDate() + 1);
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

  // Build a map of all currently scheduled lawn melds by recurring_meld ID
  // so we can find a sibling's appointment and offset by +7 days
  const siblingAppts = {};
  const scheduledLawnMelds = melds.filter(m => m.managementappointment?.find(a=>a.availability_segment?.event));
  scheduledLawnMelds.forEach(m => {
    const recurId = m.recurring_meld;
    if (!recurId) return;
    const appt = m.managementappointment.find(a=>a.availability_segment?.event).availability_segment.event;
    if (!siblingAppts[recurId]) siblingAppts[recurId] = appt;
  });
  // Also scan PENDING_COMPLETION for recently scheduled siblings
  const pcR = await api('GET', '/api/melds/?limit=200&status=PENDING_COMPLETION', sc, csrf);
  if (pcR.status === 200) {
    (JSON.parse(pcR.body).results||[]).filter(m => /lawn service/i.test(m.brief_description||'')).forEach(m => {
      const recurId = m.recurring_meld;
      if (!recurId || siblingAppts[recurId]) return;
      const appt = m.managementappointment?.find(a=>a.availability_segment?.event)?.availability_segment?.event;
      if (appt) siblingAppts[recurId] = appt;
    });
  }

  for (const m of unscheduled) {
    const recurId = m.recurring_meld;
    const propObj = (m.unit && m.unit.prop) ? m.unit.prop : m.prop;
    const propName = propObj?.property_name || '?';

    let dtstart, dtend;

    // Strategy 1: find a sibling already scheduled and add +7 days (mirrors current week exactly)
    const sibling = recurId ? siblingAppts[recurId] : null;
    if (sibling) {
      const sibStart = new Date(sibling.dtstart);
      const sibEnd   = new Date(sibling.dtend);
      sibStart.setDate(sibStart.getDate() + 7);
      sibEnd.setDate(sibEnd.getDate() + 7);
      const pad = n => String(n).padStart(2,'0');
      const fmt8601 = d => {
        const pdt = new Date(d.toLocaleString('en-US',{timeZone:'America/Los_Angeles'}));
        return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+
          pad(pdt.getHours())+':'+pad(pdt.getMinutes())+':00-07:00';
      };
      dtstart = sibling.dtstart.slice(0,10).replace(
        /(\d{4}-\d{2}-)(\d{2})/,
        (_, prefix, day) => prefix + pad(parseInt(day)+7)
      ) + sibling.dtstart.slice(10);
      dtend = sibling.dtend.slice(0,10).replace(
        /(\d{4}-\d{2}-)(\d{2})/,
        (_, prefix, day) => prefix + pad(parseInt(day)+7)
      ) + sibling.dtend.slice(10);
      // Handle month rollover properly
      const s2 = new Date(sibling.dtstart); s2.setDate(s2.getDate()+7);
      const e2 = new Date(sibling.dtend);   e2.setDate(e2.getDate()+7);
      dtstart = s2.getFullYear()+'-'+pad(s2.getMonth()+1)+'-'+pad(s2.getDate())+sibling.dtstart.slice(10);
      dtend   = e2.getFullYear()+'-'+pad(e2.getMonth()+1)+'-'+pad(e2.getDate())+sibling.dtend.slice(10);
    } else {
      // Strategy 2: fall back to TEMPLATE map if no sibling found
      const tmpl = recurId ? TEMPLATE[recurId] : null;
      if (!tmpl) {
        console.log('UNKNOWN: no sibling or template for', m.reference_id, '| prop:', propName, '| recurring_meld:', recurId);
        unknown++;
        continue;
      }
      const targetDate = nextOccurrence(tmpl.day, today, 1);
      if (!targetDate) { skipped++; continue; }
      const s = slotStr(targetDate, tmpl.hr, tmpl.min, tmpl.dur);
      dtstart = s.dtstart; dtend = s.dtend;
    }

    const durHrs = (new Date(dtend) - new Date(dtstart)) / 3600000;
    process.stdout.write(`${m.reference_id} [${propName}] → ${fmt(dtstart)} (${durHrs.toFixed(1)}h) ... `);

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
