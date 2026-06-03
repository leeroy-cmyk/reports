const https = require('https');
const BASE = 'https://app.propertymeld.com', MGMT = '2975';
const WADE_ID = 48355, JUSTIN_ID = 59624;
const SPOKANE_GROUP = 25113;

const PEST_PATTERN = /pest|bed.?bug|termite|rodent|mice|mouse|trap|exterminate|infest/i;
const PRI = {Emergency:0,Urgent:0,High:1,Normal:2,Medium:2,Low:3};

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
  const bodyStr = body!=null ? JSON.stringify(body) : null;
  const h = {'User-Agent':'Mozilla/5.0','Cookie':sc(),'X-CSRFToken':csrf,'Accept':'application/json','Referer':BASE+'/'+MGMT+'/m/'+MGMT+'/'};
  if(bodyStr){h['Content-Type']='application/json';h['Content-Length']=Buffer.byteLength(bodyStr);}
  return httpreq(method, BASE+'/'+MGMT+'/m/'+MGMT+path, h, bodyStr);
}

function isSpokaneRepair(m) {
  const pg = m.unit?.prop?.denormalized_property_groups || [];
  return pg.includes(SPOKANE_GROUP) &&
    m.work_type !== 'ENVIRONMENTAL' &&
    !m.project &&
    !PEST_PATTERN.test(m.brief_description||'');
}

function estimateDuration(brief) {
  const b = (brief||'').toLowerCase();
  if (/key|lock|code|fob|mailbox/.test(b)) return 1;
  if (/leak|water|plumb|toilet|drain/.test(b)) return 2;
  if (/garage door/.test(b)) return 1.5;
  if (/window|blind|screen/.test(b)) return 1;
  if (/oven|stove|washer|dryer|dishwasher|refrigerator|ac|air.?cond/.test(b)) return 2;
  if (/roof|tile|wall/.test(b)) return 2;
  if (/seal|caulk|reseal/.test(b)) return 1.5;
  if (/fan|light|switch|speed/.test(b)) return 1;
  if (/estimate|walkthrough/.test(b)) return 1;
  return 1.5;
}

function localDate(offset) {
  offset = offset || 0;
  const d = new Date(Date.now() + offset*86400000);
  const pdt = new Date(d.toLocaleString('en-US',{timeZone:'America/Los_Angeles'}));
  return pdt.getFullYear()+'-'+String(pdt.getMonth()+1).padStart(2,'0')+'-'+String(pdt.getDate()).padStart(2,'0');
}

function buildBusy(melds) {
  const byDate = {};
  melds.forEach(function(m) {
    const appt = m.managementappointment && m.managementappointment.find(function(a){ return a.availability_segment && a.availability_segment.event; });
    if (!appt) return;
    const evt = appt.availability_segment.event;
    const date = evt.dtstart.slice(0,10);
    if (!byDate[date]) byDate[date] = [];
    const s = new Date(evt.dtstart), e = new Date(evt.dtend);
    byDate[date].push({start: s.getUTCHours()-7 + s.getUTCMinutes()/60, end: e.getUTCHours()-7 + e.getUTCMinutes()/60});
  });
  return byDate;
}

function findSlot(busy, durHrs, fromDate) {
  const today = localDate();
  let d = new Date(fromDate+'T12:00:00-07:00');
  for (let i=0; i<28; i++) {
    d.setDate(d.getDate()+1);
    const ds = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    if (d.getDay()===0 || d.getDay()===1 || d.getDay()===6 || ds<=today) continue;
    const b = (busy[ds]||[]).sort(function(a,b){return a.start-b.start;});
    const candidates = [8,9,10,11,13,14,15,16];
    for (let ci=0; ci<candidates.length; ci++) {
      const start = candidates[ci];
      const end = start+durHrs;
      if (end>17.5) continue;
      if (!b.some(function(x){ return start < x.end+0.5 && end+0.5 > x.start; })) {
        const hr=Math.floor(start), min=Math.round((start-hr)*60);
        return {date:ds, startHr:hr, startMin:min, durationHrs:durHrs};
      }
    }
  }
  return null;
}

function slotStr(date,hr,min,dur) {
  const pad=function(n){return String(n).padStart(2,'0');};
  const endMin = hr*60+min+Math.round(dur*60);
  return {dtstart:date+'T'+pad(hr)+':'+pad(min)+':00-07:00', dtend:date+'T'+pad(Math.floor(endMin/60))+':'+pad(endMin%60)+':00-07:00'};
}

async function schedMeld(id, dtstart, dtend, started, sc, csrf) {
  if (started) {
    return api('PATCH', '/api/melds/'+id+'/segments/reschedule/', sc, csrf,
      {mark_scheduled:true,segments_to_keep:[],new_segments:[{event:{dtstart:dtstart,dtend:dtend}}]});
  }
  const r = await api('PATCH', '/api/melds/'+id+'/accept/', sc, csrf,
    {mark_scheduled:true,segments_to_keep:[],management_availability_segments:[{event:{dtstart:dtstart,dtend:dtend}}]});
  if (r.status===400 && r.body.includes('already been started')) {
    return api('PATCH', '/api/melds/'+id+'/segments/reschedule/', sc, csrf,
      {mark_scheduled:true,segments_to_keep:[],new_segments:[{event:{dtstart:dtstart,dtend:dtend}}]});
  }
  return r;
}

async function cancelStale(meldId, keepDate, sc, csrf) {
  const r = await api('GET', '/api/melds/'+meldId+'/', sc, csrf);
  if (r.status!==200) return;
  const m = JSON.parse(r.body);
  for (const a of (m.managementappointment||[])) {
    const d = a.availability_segment && a.availability_segment.event && a.availability_segment.event.dtstart.slice(0,10);
    if (d !== keepDate) await api('PATCH', '/api/management-appointments/'+a.id+'/cancel/', sc, csrf, {});
  }
}

const fmt = function(iso) {
  return new Date(iso).toLocaleString('en-US',{timeZone:'America/Los_Angeles',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
};

async function main() {
  const login_result = await login();
  const sc = login_result.sc, csrf = login_result.csrf;
  const today = localDate();

  // Load all Spokane Wade+Justin repair melds
  const statuses = ['PENDING_ASSIGNMENT','PENDING_MORE_MANAGEMENT_AVAILABILITY','PENDING_COMPLETION'];
  let melds = [];
  for (let si=0; si<statuses.length; si++) {
    const s = statuses[si];
    let offset=0;
    while(true) {
      const r = await api('GET', '/api/melds/?limit=200&offset='+offset+'&status='+s, sc, csrf);
      if (r.status!==200) break;
      const d = JSON.parse(r.body);
      const filtered = (d.results||[]).filter(function(m) {
        return isSpokaneRepair(m) && m.in_house_servicers && m.in_house_servicers.some(function(s){ return s.agent && (s.agent.id===WADE_ID||s.agent.id===JUSTIN_ID); });
      });
      melds = melds.concat(filtered);
      if (!d.next||!d.results||!d.results.length) break;
      offset+=200;
    }
  }
  const seen=new Set();
  melds=melds.filter(function(m){if(seen.has(m.id))return false;seen.add(m.id);return true;});
  console.log('Loaded '+melds.length+' Wade/Justin Spokane melds');

  // Also reassign TCDYN9AB (Scott back door repair) to Justin
  const tcdynR = await api('GET', '/api/melds/?limit=200&status=PENDING_COMPLETION', sc, csrf);
  if (tcdynR.status===200) {
    const tcdyn = (JSON.parse(tcdynR.body).results||[]).find(function(m){return m.reference_id==='TCDYN9AB';});
    if (tcdyn && tcdyn.in_house_servicers && !tcdyn.in_house_servicers.some(function(s){return s.agent&&(s.agent.id===WADE_ID||s.agent.id===JUSTIN_ID);})) {
      process.stdout.write('Reassigning TCDYN9AB (back door) from Scott to Justin... ');
      const ra = await api('PATCH', '/api/melds/'+tcdyn.id+'/assign-maintenance/', sc, csrf, {maintenance:[{id:JUSTIN_ID,type:'ManagementAgent'}],user_groups:[]});
      console.log(ra.status<300 ? 'OK' : 'FAIL '+ra.status);
      if (ra.status<300) {
        tcdyn.in_house_servicers = [{agent:{id:JUSTIN_ID,first_name:'Justin',last_name:'Gutierrez'}}];
        melds.push(tcdyn);
      }
    }
  }

  // Build busy calendars per tech
  const wadeMelds   = melds.filter(function(m){return m.in_house_servicers&&m.in_house_servicers.some(function(s){return s.agent&&s.agent.id===WADE_ID;});});
  const justinMelds = melds.filter(function(m){return m.in_house_servicers&&m.in_house_servicers.some(function(s){return s.agent&&s.agent.id===JUSTIN_ID;});});
  const wadeBusy   = buildBusy(wadeMelds);
  const justinBusy = buildBusy(justinMelds);

  const twoHoursAgo = new Date(Date.now()-2*3600000);
  const toSchedule = [];

  for (let mi=0; mi<melds.length; mi++) {
    const m = melds[mi];
    const appt = m.managementappointment && m.managementappointment.find(function(a){return a.availability_segment&&a.availability_segment.event;});
    const apptEvt = appt && appt.availability_segment.event;
    const isPastDue = apptEvt && new Date(apptEvt.dtend)<twoHoursAgo && apptEvt.dtstart.slice(0,10)!==today;
    const isUnscheduled = !apptEvt;
    const isWade = m.in_house_servicers && m.in_house_servicers.some(function(s){return s.agent&&s.agent.id===WADE_ID;});
    if (isPastDue || isUnscheduled) {
      toSchedule.push({m:m, reason:isPastDue?'past-due ('+apptEvt.dtstart.slice(0,10)+')':'unscheduled', isWade:isWade});
    }
  }

  // Sort by priority
  toSchedule.sort(function(a,b){return (PRI[a.m.priority]||2)-(PRI[b.m.priority]||2);});
  console.log('Need scheduling: '+toSchedule.length);

  for (let ti=0; ti<toSchedule.length; ti++) {
    const item = toSchedule[ti];
    const m = item.m;
    const dur = estimateDuration(m.brief_description);
    const busy = item.isWade ? wadeBusy : justinBusy;
    const techName = item.isWade ? 'Wade' : 'Justin';
    const slot = findSlot(busy, dur, today);
    if (!slot) { console.log('No slot for '+m.reference_id); continue; }
    const times = slotStr(slot.date, slot.startHr, slot.startMin, dur);
    process.stdout.write(m.reference_id+' ['+m.priority+'] '+techName+' '+fmt(times.dtstart)+' ('+dur+'h) ['+item.reason+']... ');
    const r = await schedMeld(m.id, times.dtstart, times.dtend, m.started, sc, csrf);
    if (r.status<300) {
      console.log('OK');
      await cancelStale(m.id, slot.date, sc, csrf);
      if (!busy[slot.date]) busy[slot.date]=[];
      busy[slot.date].push({start:slot.startHr+slot.startMin/60, end:slot.startHr+slot.startMin/60+dur});
    } else {
      console.log('FAIL '+r.status+' '+r.body.slice(0,80));
    }
  }

  // Print final summary
  console.log('\n=== Spokane Schedule — Wade & Justin ===');
  melds.sort(function(a,b){
    const da=(a.managementappointment&&a.managementappointment.find(function(x){return x.availability_segment&&x.availability_segment.event;})||{availability_segment:{event:{dtstart:'zzz'}}}).availability_segment&&(a.managementappointment.find(function(x){return x.availability_segment&&x.availability_segment.event;})||{}).availability_segment.event.dtstart||'zzz';
    const db=(b.managementappointment&&b.managementappointment.find(function(x){return x.availability_segment&&x.availability_segment.event;})||{}).availability_segment&&(b.managementappointment.find(function(x){return x.availability_segment&&x.availability_segment.event;})||{}).availability_segment.event.dtstart||'zzz';
    return da.localeCompare(db);
  });
  melds.forEach(function(m) {
    const appt = m.managementappointment && m.managementappointment.find(function(a){return a.availability_segment&&a.availability_segment.event;});
    const apptEvt = appt && appt.availability_segment.event;
    const tech = m.in_house_servicers && m.in_house_servicers.map(function(s){return s.agent&&s.agent.first_name;}).filter(Boolean).join('+');
    const apptStr = apptEvt ? fmt(apptEvt.dtstart) : 'NO APPT';
    const isPastDue = apptEvt && new Date(apptEvt.dtend)<twoHoursAgo && apptEvt.dtstart.slice(0,10)!==today;
    const flag = isPastDue?' PAST-DUE':(!apptEvt?' UNSCHEDULED':'');
    console.log((m.reference_id||'').padEnd(11)+'|'+(m.priority||'?').padEnd(9)+'|'+(tech||'?').padEnd(8)+'|'+(m.brief_description||'').slice(0,30).padEnd(31)+'| '+apptStr+flag);
  });
}
main().catch(function(e){console.error('FATAL:',e.message);});
