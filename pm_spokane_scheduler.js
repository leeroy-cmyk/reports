#!/usr/bin/env node
/**
 * PropertyMeld Spokane Scheduler — Wade Hippen + Justin Gutierrez (repairs).
 * Runs daily via GitHub Actions (.github/workflows/pm-spokane-scheduler.yml).
 * Full parity with the Tacoma (Jonas) scheduler: assigns/reassigns Spokane non-turn
 * repairs to Wade/Justin (balanced), honors stated day/time/date preferences, reads
 * chats, reschedules past-due, relocates anything on a reserved day (Mon/weekend) or
 * double-booked, then compacts each tech's calendar to fill the nearest days first.
 * Set DRY_RUN=1 to preview without writing.
 *
 * Scope: Spokane property groups (25113 + Our Natural Homes 25115), non-project,
 * work_type != ENVIRONMENTAL (lawn → David/Alexander), not pest (unassigned pest skipped).
 * Turns (project melds) → Scott/Ron/Magoon, never touched here.
 */
const https = require('https');
const { analyzeChat } = require('./pm_chat_llm'); // LLM chat reader; no-ops to null without ANTHROPIC_API_KEY
const BASE = 'https://app.propertymeld.com', MGMT = '2975';
const WADE_ID = 48355, JUSTIN_ID = 59624;
const TECHS = [{ id: WADE_ID, name: 'Wade' }, { id: JUSTIN_ID, name: 'Justin' }];
const TECH_IDS = new Set([WADE_ID, JUSTIN_ID]);
const SPOKANE_GROUPS = [25113, 25115];
const DRY = !!process.env.DRY_RUN;
const PEST_RE = /pest|bed.?bug|termite|rodent|mice|mouse|trap|exterminate|infest/i;
const PRIORITY_ORDER = { Emergency:0, Urgent:0, High:1, Normal:2, Medium:2, Low:3 };
const MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};

// ── HTTP / AUTH ───────────────────────────────────────────────────────────────
async function httpreq(method, urlStr, headers, bodyStr) {
  return new Promise((res, rej) => {
    const u = new URL(urlStr);
    const r = https.request({hostname:u.hostname,path:u.pathname+u.search,method,headers:headers||{}}, resp => {
      let b=''; resp.on('data',d=>b+=d); resp.on('end',()=>res({status:resp.statusCode,headers:resp.headers,body:b}));
    }).on('error',rej);
    if (bodyStr) r.write(bodyStr); r.end();
  });
}
async function login() {
  let jar = {};
  function add(h){ if(!h||!h['set-cookie'])return; h['set-cookie'].forEach(c=>{const kv=c.split(';')[0];const eq=kv.indexOf('=');if(eq>0)jar[kv.slice(0,eq).trim()]=kv.slice(eq+1);}); }
  const sc = () => Object.entries(jar).map(([k,v])=>k+'='+v).join('; ');
  const r1 = await httpreq('GET', BASE+'/login/?next=/', {'User-Agent':'Mozilla/5.0'}); add(r1.headers);
  const csrf1 = (r1.body.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/)||[])[1];
  const bd = new URLSearchParams({csrfmiddlewaretoken:csrf1,email:process.env.PROPERTYMELD_EMAIL,password:process.env.PROPERTYMELD_PASSWORD}).toString();
  const r2 = await httpreq('POST', BASE+'/login/?next=/', {'User-Agent':'Mozilla/5.0','Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(bd),'Referer':BASE+'/login/?next=/','Cookie':sc()}, bd); add(r2.headers);
  const r3 = await httpreq('GET', BASE+'/'+MGMT+'/m/'+MGMT+'/dashboard/', {'User-Agent':'Mozilla/5.0','Cookie':sc()}); add(r3.headers);
  const m = r3.body.match(/window\.PM\.csrf_token\s*=\s*"([^"]+)"/);
  return { sc, csrf: m ? m[1] : '' };
}
async function apiGet(path, sc, csrf) {
  return httpreq('GET', BASE+'/'+MGMT+'/m/'+MGMT+path, {'User-Agent':'Mozilla/5.0','Cookie':sc(),'X-CSRFToken':csrf,'Accept':'application/json','Referer':BASE+'/'+MGMT+'/m/'+MGMT+'/'}, null);
}
async function apiPatch(path, sc, csrf, body) {
  if (DRY) { console.log('   [DRY] would PATCH '+path); return {status:200, body:'{}'}; }
  const s = JSON.stringify(body);
  return httpreq('PATCH', BASE+'/'+MGMT+'/m/'+MGMT+path, {'User-Agent':'Mozilla/5.0','Cookie':sc(),'X-CSRFToken':csrf,'Accept':'application/json','Content-Type':'application/json','Content-Length':Buffer.byteLength(s),'Referer':BASE+'/'+MGMT+'/m/'+MGMT+'/'}, s);
}

// ── DATE/TIME HELPERS ─────────────────────────────────────────────────────────
function localDate(offset) {
  const d = new Date(Date.now() + (offset||0)*86400000);
  const p = new Date(d.toLocaleString('en-US',{timeZone:'America/Los_Angeles'}));
  return p.getFullYear()+'-'+String(p.getMonth()+1).padStart(2,'0')+'-'+String(p.getDate()).padStart(2,'0');
}
function isBlockedDay(dateStr){ const d=new Date(dateStr+'T12:00:00-07:00').getDay(); return d===0||d===1||d===6; } // Sun/Mon/Sat
function pdtDate(iso){ const l=new Date(new Date(iso).toLocaleString('en-US',{timeZone:'America/Los_Angeles'})); return l.getFullYear()+'-'+String(l.getMonth()+1).padStart(2,'0')+'-'+String(l.getDate()).padStart(2,'0'); }
function pdtHr(iso){ const l=new Date(new Date(iso).toLocaleString('en-US',{timeZone:'America/Los_Angeles'})); return l.getHours()+l.getMinutes()/60; }
function nowPdtHr(){ const l=new Date(new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles'})); return l.getHours()+l.getMinutes()/60; }
function parseTime(s){ if(!s)return null; const m=/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(s); if(!m)return null; let hr=parseInt(m[1]); const min=parseInt(m[2]||'0'); const ap=m[3].toLowerCase(); if(ap==='pm'&&hr<12)hr+=12; if(ap==='am'&&hr===12)hr=0; return {hr,min}; }
function nextAvailableDate(afterDate){ let d=new Date(afterDate+'T12:00:00-07:00'); for(let i=0;i<30;i++){ d.setDate(d.getDate()+1); const ds=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); if(d.getDay()!==0&&d.getDay()!==1&&d.getDay()!==6)return ds; } return null; }
function nextOccurrenceOfDay(dayName, afterDate){ const DAYS={sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6}; const t=DAYS[dayName.toLowerCase()]; if(t===undefined)return null; const wknd=t===0||t===6; let d=new Date(afterDate+'T12:00:00-07:00'); d.setDate(d.getDate()+1); for(let i=0;i<14;i++){ if(d.getDay()===t&&(wknd||d.getDay()!==1)) return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); d.setDate(d.getDate()+1); } return null; }
function slot(date,hr,min,dur){ const pad=n=>String(n).padStart(2,'0'); const tot=hr*60+min+Math.round(dur*60); return {dtstart:`${date}T${pad(hr)}:${pad(min)}:00-07:00`, dtend:`${date}T${pad(Math.floor(tot/60))}:${pad(tot%60)}:00-07:00`}; }
const fmt = iso => new Date(iso).toLocaleString('en-US',{timeZone:'America/Los_Angeles',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});

// Spokane list API returns dtstart directly on the appointment OR nested under availability_segment.event
function getMeldAppt(m){ for(const a of (m.managementappointment||[])){ if(a.dtstart&&a.dtend)return a; if(a.availability_segment&&a.availability_segment.event&&a.availability_segment.event.dtstart)return a.availability_segment.event; } return null; }
function apptCreatedOf(m){ return (m.managementappointment||[]).map(a=>a.created).filter(Boolean)[0]||null; }
// Apply a (re)schedule robustly. STARTED/in-progress melds use segments/reschedule/;
// not-yet-started melds (incl. scheduled PENDING_MORE_MANAGEMENT_AVAILABILITY) use accept/.
// Falls back across the boundary on the specific PM error so neither case 400s.
async function applyMove(m, dtstart, dtend, sc, csrf){
  const resched=()=>apiPatch('/api/melds/'+m.id+'/segments/reschedule/',sc,csrf,{mark_scheduled:true,segments_to_keep:[],new_segments:[{event:{dtstart,dtend}}]});
  const accept =()=>apiPatch('/api/melds/'+m.id+'/accept/',sc,csrf,{mark_scheduled:true,segments_to_keep:[],management_availability_segments:[{event:{dtstart,dtend}}]});
  if(m.started){ let r=await resched(); if(r.status===400&&/been started/i.test(r.body)) r=await accept(); return r; }
  let r=await accept(); if(r.status===400&&/already been started/i.test(r.body)) r=await resched(); return r;
}
// After a move, cancel any appointment NOT on the kept date — otherwise stale appts linger and
// the meld re-reads as past-due / double-booked on the next run (breaks idempotency).
async function cancelStale(meldId, keepDate, sc, csrf){
  if(DRY)return;
  const r=await apiGet('/api/melds/'+meldId+'/',sc,csrf); if(r.status!==200)return;
  const m=JSON.parse(r.body); let keptOne=false;
  for(const a of (m.managementappointment||[])){
    const ds=a.dtstart||(a.availability_segment&&a.availability_segment.event&&a.availability_segment.event.dtstart);
    const d=ds?pdtDate(ds):null;
    if(d===keepDate&&!keptOne){ keptOne=true; continue; }                   // keep exactly ONE appt on the target date
    if(d) await apiPatch('/api/management-appointments/'+a.id+'/cancel/',sc,csrf,{}); // cancel other dates AND same-date duplicates
  }
}
// Proactive dedup: a meld left UNTOUCHED by the scheduler keeps any pre-existing duplicate
// appointments forever (cancelStale only runs on melds we actively move). A ghost duplicate is
// also invisible to buildBusyBlocks (it reads only getMeldAppt's first appt) → silent double-book.
// So before building the busy calendars, collapse every meld to exactly ONE real appt
// (keep the most recently created = highest id; "last write wins"). Mutates the meld objects.
async function dedupeAppts(melds, sc, csrf){
  let removed=0;
  for(const m of melds){
    const isReal=a=>(a.dtstart&&a.dtend)||(a.availability_segment&&a.availability_segment.event&&a.availability_segment.event.dtstart);
    const real=(m.managementappointment||[]).filter(isReal);
    if(real.length<=1)continue;
    real.sort((a,b)=>(b.id||0)-(a.id||0)); const keep=real[0];
    for(const a of real.slice(1)){
      const ds=a.dtstart||(a.availability_segment&&a.availability_segment.event&&a.availability_segment.event.dtstart);
      console.log('  dedupe '+(m.reference_id||m.id)+': cancel duplicate appt '+a.id+' ('+(ds?pdtDate(ds):'?')+')');
      if(!DRY) await apiPatch('/api/management-appointments/'+a.id+'/cancel/',sc,csrf,{});
      removed++;
    }
    m.managementappointment=(m.managementappointment||[]).filter(a=>a===keep||!real.includes(a));
  }
  if(removed)console.log('Deduped '+removed+' duplicate appointment(s)');
}

// ── PREFERENCE LOCK (same rules as Tacoma) ──────────────────────────────────────
function extractPreference(text){
  if(!text)return null; const t=String(text);
  const dayName=(t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)||[])[1]||null;
  const time=(t.match(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i)||[])[0]||null;
  let dateStr=null;
  const mon=t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  const mdy=t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if(mon){const mm=MONTHS[mon[1].toLowerCase()],dd=parseInt(mon[2]);if(mm&&dd>=1&&dd<=31)dateStr='2026-'+String(mm).padStart(2,'0')+'-'+String(dd).padStart(2,'0');}
  else if(mdy){const mm=parseInt(mdy[1]),dd=parseInt(mdy[2]);if(mm>=1&&mm<=12&&dd>=1&&dd<=31)dateStr='2026-'+String(mm).padStart(2,'0')+'-'+String(dd).padStart(2,'0');}
  if(!dayName&&!time&&!dateStr)return null; return {dayName,time,dateStr};
}
function usablePreference(pref, today){ if(!pref)return null; const out={dayName:pref.dayName||null,time:pref.time||null,dateStr:(pref.dateStr&&pref.dateStr>=today)?pref.dateStr:null}; return (out.dayName||out.time||out.dateStr)?out:null; }
function apptMatchesPref(apptEvt, pref){ if(!apptEvt||!pref)return false; const d=pdtDate(apptEvt.dtstart);
  if(pref.dateStr&&d!==pref.dateStr)return false;
  if(pref.dayName){const DAYS={sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6};if(new Date(d+'T12:00:00-07:00').getDay()!==DAYS[pref.dayName.toLowerCase()])return false;}
  if(pref.time){const pt=parseTime(pref.time);if(pt&&Math.abs(pdtHr(apptEvt.dtstart)-(pt.hr+pt.min/60))>0.01)return false;}
  return true;
}

// ── SLOT FINDING ────────────────────────────────────────────────────────────────
function estimateDuration(brief){
  const b=(brief||'').toLowerCase();
  if(/key|lock|code|fob|mailbox/.test(b))return 1;
  if(/leak|water|plumb|toilet|drain/.test(b))return 2;
  if(/garage door/.test(b))return 1.5;
  if(/window|blind|screen/.test(b))return 1;
  if(/oven|stove|washer|dryer|dishwasher|refrigerator|ac|air.?cond/.test(b))return 2;
  if(/roof|tile|wall/.test(b))return 2;
  if(/seal|caulk|reseal/.test(b))return 1.5;
  if(/fan|light|switch|speed/.test(b))return 1;
  if(/estimate|walkthrough/.test(b))return 1;
  return 1.5;
}
function buildBusyBlocks(melds){ const byDate={}; melds.forEach(m=>{ const e=getMeldAppt(m); if(!e)return; const d=pdtDate(e.dtstart); (byDate[d]=byDate[d]||[]).push({start:pdtHr(e.dtstart),end:pdtHr(e.dtend)}); }); return byDate; }
function findOverlaps(melds){ const ov=new Set(),byDate={}; melds.forEach(m=>{const e=getMeldAppt(m);if(!e)return;const d=pdtDate(e.dtstart);(byDate[d]=byDate[d]||[]).push({m,start:pdtHr(e.dtstart),end:pdtHr(e.dtend)});});
  for(const d in byDate){ const list=byDate[d].sort((a,b)=>(PRIORITY_ORDER[a.m.priority]??2)-(PRIORITY_ORDER[b.m.priority]??2)||a.start-b.start); const kept=[]; for(const it of list){ if(kept.some(k=>it.start<k.end&&it.end>k.start))ov.add(it.m.id); else kept.push(it); } }
  return ov;
}
// Earliest free slot from `startingFrom`, packed from 8am, skipping today/Mon/weekend. Fill nearest first.
function findNextSlot(busy, durHrs, startingFrom, bufferHrs=0.5){
  const today=localDate(); let d=new Date(startingFrom+'T12:00:00-07:00');
  for(let i=0;i<28;i++){ const ds=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    if(d.getDay()===0||d.getDay()===1||d.getDay()===6||ds<=today){ d.setDate(d.getDate()+1); continue; }
    const b=(busy[ds]||[]).sort((a,b)=>a.start-b.start);
    for(let s=8;s<=17-durHrs;s+=0.25){ const e=s+durHrs; if(!b.some(x=>s<x.end+bufferHrs&&e+bufferHrs>x.start)) return {date:ds,startHr:Math.floor(s),startMin:Math.round((s-Math.floor(s))*60),durationHrs:durHrs}; }
    d.setDate(d.getDate()+1);
  }
  return null;
}
function findSlotOnDate(busy, durHrs, dateStr, bufferHrs=0.5, minStart=8){
  const b=(busy[dateStr]||[]).sort((a,b)=>a.start-b.start);
  for(let s=Math.max(8,minStart);s<=17-durHrs;s+=0.25){ const e=s+durHrs; if(!b.some(x=>s<x.end+bufferHrs&&e+bufferHrs>x.start)) return {date:dateStr,startHr:Math.floor(s),startMin:Math.round((s-Math.floor(s))*60),durationHrs:durHrs}; }
  return null;
}
// Hard-pinned date (e.g. a date written into the meld TITLE): MUST land on this exact date.
// Use a clean gap if one exists; otherwise stack right after the last job (the date is non-negotiable).
function forceSlotOnDate(busy, durHrs, dateStr, bufferHrs=0.5){
  const clean=findSlotOnDate(busy,durHrs,dateStr,bufferHrs,8);
  if(clean)return clean;
  const b=(busy[dateStr]||[]).slice().sort((a,b)=>a.start-b.start);
  let start=b.length?b[b.length-1].end+bufferHrs:8;
  if(start+durHrs>18)start=Math.max(8,18-durHrs);   // keep within ~6pm; may abut, but the date is fixed
  const hr=Math.floor(start),min=Math.round((start-hr)*60);
  return {date:dateStr,startHr:hr,startMin:min,durationHrs:durHrs};
}
function preferredSlot(pref, durHrs, busy, today, bufferHrs=0.5){
  let date=pref.dateStr||(pref.dayName?nextOccurrenceOfDay(pref.dayName,today):null);
  if(!date||date<today)date=nextAvailableDate(today);
  if(!date)return null;
  const isToday=date===today; const minStart=isToday?Math.min(16,Math.ceil((nowPdtHr()+0.5)*4)/4):8;
  const pt=pref.time?parseTime(pref.time):null;
  if(pt){ const start=pt.hr+pt.min/60,end=start+durHrs; const conflict=(busy[date]||[]).some(b=>start<b.end+bufferHrs&&end+bufferHrs>b.start); if(start>=minStart&&end<=17&&!conflict)return {date,startHr:pt.hr,startMin:pt.min,durationHrs:durHrs}; }
  return findSlotOnDate(busy,durHrs,date,bufferHrs,minStart)||findNextSlot(busy,durHrs,today);
}

// ── CHAT PARSING (recency-bounded) ──────────────────────────────────────────────
const RESCHEDULE_KW=/reschedul|re-?schedul|different (time|day|date)|change (the |my |it |to )?(time|day|date|appointment|appt)|can'?t (make|do|be (home|there|here))|cannot (make|do|be)|won'?t be (home|here|there|available|around|in)|not (available|free|home|gonna be home|going to be home)|unavailable|out of town|out of the office|on (vacation|holiday|leave)|need to (move|change|reschedul|switch|push|delay)|have to (move|change|reschedul|switch|push)|switch (the |to )?(time|day|date|it)|conflict|postpone|delay|push (it|this|back|out|to)|move (it|this|that|my appt|the appt|appointment|the appointment)?\s*(back|up|to|out|earlier|later)?|another (day|time)|some other (day|time)|other (day|time)|reschedul\w* for|come back (a|another|on|later)/i;
const ACCOMMODATE_KW=/available|i'?m free|i am free|i'?ll be (home|here|available|around|in)|works (for me|better|best)|that works|good time|(would )?prefer|better (time|day|to|if)|can (you|we|someone) (come|do it|make it|stop by|swing by|schedule)|please come|any ?time|only (free|available)|best time|suits me|convenient|whenever (works|you|is)|let'?s do|how about|mornings?|afternoons?|evenings?|before noon|after \d|between \d/i;
const DURATION_KW=/(\d+)\s*(min|mins|minute|minutes|hr|hrs|hour|hours)\b/i;
const EARLIER_KW=/\b(earlier|sooner|asap)\b|as soon as possible|any ?sooner|(any|some)thing earlier|move (it|this|that)?\s*up|bump (it|this|that)?\s*up|squeeze (me|us|it|him|her|them)?\s*in|fit (me|us|it|him|her|them)?\s*in|expedite|right away|today if|tomorrow if|this week instead|before (mon|tue|wed|thu|fri|sat|sun|noon|\d|the )|no later than|not (on )?(mon|tue|wed|thu|fri|sat|sun)/i;
const TIME_KW=/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
const DAY_KW=/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i;
const TOD_KW=[[/\bmornings\b|in the morning|this morning|before noon|forenoon/i,'9:00 am'],[/\bafternoons\b|in the afternoon|this afternoon|after lunch/i,'1:00 pm'],[/\bevenings\b|in the evening|this evening|after work|end of day|\beod\b/i,'4:00 pm']];
const resolveTimeKW=t=>{const m=TIME_KW.exec(t);if(m)return m[0];for(const [re,v] of TOD_KW)if(re.test(t))return v;return null;};
function parseChatAction(messages){
  const sorted=messages.slice().sort((a,b)=>(b.created||'').localeCompare(a.created||''));
  for(const msg of sorted.slice(0,10)){
    const text=msg.text||''; const isTenant=!!msg.tenant||msg.clazz==='t'; const isAgent=!!msg.agent||msg.clazz==='m';
    const sender=msg.tenant?((msg.tenant.first_name||'')+' '+(msg.tenant.last_name||'')).trim():msg.agent?((msg.agent.user&&msg.agent.user.first_name||'')+' '+(msg.agent.user&&msg.agent.user.last_name||'')).trim():(msg.commenter_name||'unknown');
    const msgDate=(msg.created||'').slice(0,10);
    const dm=DURATION_KW.exec(text);
    if(dm&&isAgent){ const num=parseFloat(dm[1]); const hrs=dm[2].toLowerCase().startsWith('h')?num:num/60; return {action:'shorten',durationHrs:hrs,note:text.slice(0,80),sender,msgDate}; }
    if(RESCHEDULE_KW.test(text)||EARLIER_KW.test(text)){ const d=DAY_KW.exec(text); const earlier=EARLIER_KW.test(text);
      // "earlier/sooner/before X / not X" → move to EARLIEST; the mentioned day is to AVOID, not target.
      return {action:'reschedule',requestedDay:earlier?null:(d?d[1]:null),requestedTime:earlier?null:resolveTimeKW(text),isTenant,note:text.slice(0,80),sender,msgDate}; }
    if(isTenant&&ACCOMMODATE_KW.test(text)){ const d=DAY_KW.exec(text); const rt=resolveTimeKW(text); if(d||rt) return {action:'accommodate_resident',requestedDay:d?d[1]:null,requestedTime:rt,note:text.slice(0,80),sender,msgDate}; }
  }
  return null;
}

// ── SCOPE FILTER ────────────────────────────────────────────────────────────────
function isSpokaneRepair(m){
  const po=(m.unit&&m.unit.prop)?m.unit.prop:m.prop;
  const pg=(po&&po.denormalized_property_groups)||[];
  if(!SPOKANE_GROUPS.some(g=>pg.includes(g)))return false;
  if(m.work_type==='ENVIRONMENTAL'||m.project)return false;          // lawn → David/Alex; turns → Scott/Ron/Magoon
  if(PEST_RE.test(m.brief_description||'')) return !!(m.in_house_servicers&&m.in_house_servicers.length>0); // unassigned pest skipped
  return true;
}
const hasTech=(m,id)=>m.in_house_servicers&&m.in_house_servicers.some(s=>s.agent&&s.agent.id===id);
// Turn techs — they legitimately hold TURN (project) melds. Only reclaim from them when they
// wrongly hold a NON-project repair (like the old TCDYN9AB Scott back-door case).
const TURN_TECHS=new Set([48356,48379,50779]); // Scott Higley, Ron Cramer, Micheal Magoon
// Which melds belong to Wade/Justin's queue. Deliberately does NOT touch melds held by
// David/Alexander (grounds), Florencia (pest), Dulce (estimates), etc. — those are legit
// non-repair assignments and must be left alone.
function inScope(m){
  if(!isSpokaneRepair(m))return false;
  const ids=(m.in_house_servicers||[]).map(s=>s.agent&&s.agent.id).filter(Boolean);
  if(ids.some(id=>TECH_IDS.has(id)))return true;                       // already Wade/Justin
  if(ids.length===0)return !PEST_RE.test(m.brief_description||'');     // unassigned non-pest → claim
  if(ids.every(id=>TURN_TECHS.has(id)))return true;                    // turn tech wrongly holds a repair → reclaim
  return false;                                                        // anyone else → leave alone
}

// ── MAIN ─────────────────────────────────────────────────────────────────────────
async function main(){
  const {sc,csrf}=await login();
  const today=localDate();
  console.log('=== Spokane Scheduler (Wade+Justin) '+new Date().toISOString()+(DRY?' [DRY_RUN]':'')+' ===');

  // 1. Fetch all melds across statuses; collect Spokane repairs + each tech's full calendar
  const statuses=['PENDING_ASSIGNMENT','PENDING_MORE_MANAGEMENT_AVAILABILITY','PENDING_COMPLETION'];
  let repairs=[]; const techAll={[WADE_ID]:[],[JUSTIN_ID]:[]};
  for(const s of statuses){ let off=0; while(true){ const r=await apiGet('/api/melds/?limit=200&offset='+off+'&status='+s,sc,csrf); if(r.status!==200)break; const d=JSON.parse(r.body);
    (d.results||[]).forEach(m=>{ if(inScope(m))repairs.push(m); for(const t of TECHS) if(hasTech(m,t.id))techAll[t.id].push(m); });
    if(!d.next||!d.results||!d.results.length)break; off+=200; } }
  const seen=new Set(); repairs=repairs.filter(m=>{if(seen.has(m.id))return false;seen.add(m.id);return true;});
  for(const t of TECHS){ const s2=new Set(); techAll[t.id]=techAll[t.id].filter(m=>{if(s2.has(m.id))return false;s2.add(m.id);return true;}); }

  // 1b. Collapse duplicate appointments to one per meld (keep newest) BEFORE building busy
  // calendars, so ghost duplicates can't cause silent double-booking. Mutates the meld objects.
  for(const t of TECHS) await dedupeAppts(techAll[t.id], sc, csrf);

  // 2. Assign/reassign: balance unassigned + non-Spokane-tech melds onto Wade/Justin
  let load={[WADE_ID]:techAll[WADE_ID].length,[JUSTIN_ID]:techAll[JUSTIN_ID].length};
  for(const m of repairs){
    if(hasTech(m,WADE_ID)||hasTech(m,JUSTIN_ID))continue;        // already on a Spokane tech
    if(PEST_RE.test(m.brief_description||''))continue;            // never auto-assign pest
    const others=(m.in_house_servicers||[]).map(s=>((s.agent?.first_name||'')+' '+(s.agent?.last_name||'')).trim()).filter(Boolean);
    const to= load[JUSTIN_ID]<load[WADE_ID] ? JUSTIN_ID : WADE_ID;  // lighter tech (Wade on tie)
    const name= to===WADE_ID?'Wade':'Justin';
    console.log((others.length?'Reassigning '+m.reference_id+' to '+name+' (was on non-Spokane tech: '+others.join(', ')+')':'Auto-assigning '+m.reference_id+' to '+name+' (unassigned)'));
    const r=await apiPatch('/api/melds/'+m.id+'/assign-maintenance/',sc,csrf,{maintenance:[{id:to,type:'ManagementAgent'}],user_groups:[]});
    if(r.status<300){ m.in_house_servicers=[{agent:{id:to,first_name:name}}]; load[to]++; techAll[to].push(m); }
    else console.log('  Failed to assign: '+r.status);
  }
  console.log('Spokane repair melds: '+repairs.length+' | Wade load '+load[WADE_ID]+' / Justin load '+load[JUSTIN_ID]);

  // 3. Per-tech busy calendars + overlap detection (whole calendar, so we never double-book)
  const busy={[WADE_ID]:buildBusyBlocks(techAll[WADE_ID]),[JUSTIN_ID]:buildBusyBlocks(techAll[JUSTIN_ID])};
  const overlapIds=new Set([...findOverlaps(techAll[WADE_ID]),...findOverlaps(techAll[JUSTIN_ID])]);
  if(overlapIds.size)console.log('Overlapping appointments to relocate: '+overlapIds.size);
  const lockedPrefs=new Map();

  // 4. Decide + apply per meld
  const techIdOf=m=>hasTech(m,WADE_ID)?WADE_ID:(hasTech(m,JUSTIN_ID)?JUSTIN_ID:null);
  for(const m of repairs){
    const tid=techIdOf(m); if(!tid)continue;                     // pest left unassigned, etc.
    const tName=tid===WADE_ID?'Wade':'Justin';
    const ref=m.reference_id, brief=m.brief_description||'', priority=m.priority||'Normal';
    const apptEvt=getMeldAppt(m); const apptDate=apptEvt?pdtDate(apptEvt.dtstart):null;
    const isPastDue=apptEvt&&apptDate<today; const isUnscheduled=!apptEvt;

    // chat — recency split: scheduled melds only act on <26h messages (anti-thrash);
    // unscheduled melds honor preferences from the last 30 days.
    let messages=[];
    try{ const rc=await apiGet('/api/comments/?meld='+m.id+'&limit=50&ordering=created',sc,csrf); if(rc.status===200){ messages=JSON.parse(rc.body); if(!Array.isArray(messages))messages=messages.results||[]; } }catch(e){}
    const apptCreated=apptCreatedOf(m); const RECENCY=26*3600000;
    let newMsgs;
    if(apptEvt){ const cut=apptCreated?new Date(apptCreated).getTime():(Date.now()-RECENCY); newMsgs=messages.filter(x=>x.created&&new Date(x.created).getTime()>cut&&(Date.now()-new Date(x.created).getTime())<RECENCY); }
    else { const cut=Date.now()-30*86400000; newMsgs=messages.filter(x=>x.created&&new Date(x.created).getTime()>cut); }
    // LLM reads the full recent chat like a coordinator; keyword parser is the fallback.
    let chatAction=null, llm=null;
    const apptStrPDT=apptEvt?fmt(apptEvt.dtstart):null;
    const recentChat=messages.some(x=>x.created&&(Date.now()-new Date(x.created).getTime())<21*86400000);
    if(recentChat) llm=await analyzeChat(brief,messages,apptStrPDT,today);
    if(llm){
      if(llm.intent!=='none') chatAction = llm.earlier
        ? {action:'reschedule',requestedDay:null,requestedTime:null,isTenant:true,note:llm.reasoning,sender:'chat(LLM)',msgDate:today}
        : {action:'accommodate_resident',requestedDay:(llm.pref&&llm.pref.dayName)||null,requestedTime:(llm.pref&&llm.pref.time)||null,note:llm.reasoning,sender:'chat(LLM)',msgDate:today};
    } else {
      chatAction=newMsgs.length?parseChatAction(newMsgs):null;
    }

    // preference lock: TITLE, then LLM structured pref, then keyword-extracted day/time
    let pref=usablePreference(extractPreference(brief),today);
    if(!pref&&llm&&llm.pref) pref=usablePreference(llm.pref,today);
    if(!pref&&chatAction&&(chatAction.requestedDay||chatAction.requestedTime)) pref=usablePreference({dayName:chatAction.requestedDay||null,time:chatAction.requestedTime||null,dateStr:null},today);
    if(pref)lockedPrefs.set(m.id,pref);

    // decide action
    let action=null, reason='';
    if(pref&&(isUnscheduled||isPastDue||!apptMatchesPref(apptEvt,pref))){ action='honor_pref'; reason='preference '+JSON.stringify(pref); }
    else if(chatAction&&chatAction.action==='shorten'){ if(apptEvt){ const cur=(new Date(apptEvt.dtend)-new Date(apptEvt.dtstart))/3600000; if(cur>chatAction.durationHrs+0.1){action='shorten';reason='shorten per '+chatAction.sender;} } else action='schedule_new'; }
    else if(chatAction&&(chatAction.action==='reschedule'||chatAction.action==='accommodate_resident')){ action=chatAction.action; reason='chat '+chatAction.sender+': '+chatAction.note.slice(0,40); }
    else if(isPastDue){ action='reschedule_pastdue'; reason='past due '+apptDate; }
    else if(apptEvt&&isBlockedDay(apptDate)&&!pref){ action='reschedule_blockedday'; reason='reserved day '+apptDate; }
    else if(apptEvt&&overlapIds.has(m.id)&&!pref){ action='reschedule_overlap'; reason='double-booked '+apptDate; }
    else if(isUnscheduled){ action='schedule_new'; reason='unscheduled'; }
    if(!action)continue;

    const tbFull=busy[tid];
    // Exclude this meld's OWN appt from the search so it isn't blocked by itself (else a
    // "move earlier" reschedule pushes it to the next free slot = LATER).
    let tb=tbFull;
    if(apptEvt){ const os=pdtHr(apptEvt.dtstart),oe=pdtHr(apptEvt.dtend); tb={...tbFull,[apptDate]:(tbFull[apptDate]||[]).filter(b=>Math.abs(b.start-os)>0.01||Math.abs(b.end-oe)>0.01)}; }
    const shortenOk=chatAction&&chatAction.action==='shorten'&&chatAction.durationHrs>=0.25&&chatAction.durationHrs<=4;
    const durHrs=Math.min(8, shortenOk?chatAction.durationHrs:estimateDuration(brief));
    console.log(ref+' ['+priority+'] '+tName+' '+brief.slice(0,32)+' → '+action+': '+reason);

    // find slot
    let ns=null;
    if(action==='honor_pref'&&pref){
      if(pref.dateStr&&pref.dateStr>=today){
        // HARD DATE from the meld title (e.g. "June 23rd - POST NTE NOTICE") — must land on this
        // exact date even if it means stacking at end of day. A title date is non-negotiable;
        // never bounce it to a different day (the old behavior dumped it weeks out + gave up).
        ns=pref.time?preferredSlot(pref,durHrs,tb,today):null;
        if(!ns||ns.date!==pref.dateStr) ns=forceSlotOnDate(tb,durHrs,pref.dateStr);
      } else {
        // Soft pref (day-name/time only): honor if possible; if the stated slot is unreachable,
        // drop the lock so it isn't re-tried forever, and leave an already-scheduled meld put.
        ns=preferredSlot(pref,durHrs,tb,today);
        const t=ns?slot(ns.date,ns.startHr,ns.startMin,ns.durationHrs):null;
        if(!t||!apptMatchesPref({dtstart:t.dtstart},pref)){
          lockedPrefs.delete(m.id);
          if(apptEvt){ console.log('  (preference '+JSON.stringify(pref)+' not achievable — leaving as-is)'); continue; }
        }
      }
    }
    if(!ns&&chatAction&&chatAction.action==='accommodate_resident'&&chatAction.requestedDay){ const pd=nextOccurrenceOfDay(chatAction.requestedDay,today); if(pd){ const c=findSlotOnDate(tb,durHrs,pd); if(c)ns=c; } }
    if(action==='shorten'&&apptEvt){ // keep same day, trim end
      const sd=pdtDate(apptEvt.dtstart); ns={date:sd,startHr:Math.floor(pdtHr(apptEvt.dtstart)),startMin:Math.round((pdtHr(apptEvt.dtstart)%1)*60),durationHrs:durHrs};
    }
    if(!ns) ns=findNextSlot(tb,durHrs, today);
    if(!ns){ console.log('  no slot for '+ref); continue; }
    // Idempotency: if the best achievable slot is exactly where it already sits, do nothing
    // (e.g. an unsatisfiable date pref whose date is full keeps resolving to the same fallback).
    if(apptEvt && pdtDate(apptEvt.dtstart)===ns.date && Math.abs(pdtHr(apptEvt.dtstart)-(ns.startHr+ns.startMin/60))<0.01){ console.log('  (already optimally placed — no change)'); continue; }

    const {dtstart,dtend}=slot(ns.date,ns.startHr,ns.startMin,ns.durationHrs);
    // clear phantom appts first
    for(const a of (m.managementappointment||[])){ if(!a.availability_segment||!a.availability_segment.event){ if(!(a.dtstart&&a.dtend)) { await apiPatch('/api/management-appointments/'+a.id+'/cancel/',sc,csrf,{}); } } }
    const result=await applyMove(m,dtstart,dtend,sc,csrf);
    if(result.status>=200&&result.status<300){
      console.log('  ✓ '+ns.date+' '+String(ns.startHr).padStart(2,'0')+':'+String(ns.startMin).padStart(2,'0')+' ('+ns.durationHrs+'h)');
      await cancelStale(m.id, ns.date, sc, csrf);
      // free vacated slot, reserve new — on the REAL per-tech calendar (tbFull), not the search clone
      if(apptEvt){ const od=pdtDate(apptEvt.dtstart); if(tbFull[od]){ const os=pdtHr(apptEvt.dtstart),oe=pdtHr(apptEvt.dtend); tbFull[od]=tbFull[od].filter(b=>Math.abs(b.start-os)>0.01||Math.abs(b.end-oe)>0.01); } }
      (tbFull[ns.date]=tbFull[ns.date]||[]).push({start:ns.startHr+ns.startMin/60,end:ns.startHr+ns.startMin/60+ns.durationHrs});
    } else console.log('  ✗ FAIL '+result.status+' '+result.body.slice(0,80));
  }

  // 5. Compaction — per tech, pull scheduled repairs into nearest open slots. Locked melds exempt.
  // REFETCH fresh state first: the main loop mutated PM appointments but not the in-memory
  // objects, so compacting off stale appts would re-create overlaps.
  const freshByTech={[WADE_ID]:[],[JUSTIN_ID]:[]};
  for(const s of statuses){ let off=0; while(true){ const r=await apiGet('/api/melds/?limit=200&offset='+off+'&status='+s,sc,csrf); if(r.status!==200)break; const d=JSON.parse(r.body); (d.results||[]).forEach(m=>{ for(const t of TECHS) if(hasTech(m,t.id))freshByTech[t.id].push(m); }); if(!d.next||!d.results||!d.results.length)break; off+=200; } }
  for(const t of TECHS){ const sd=new Set(); freshByTech[t.id]=freshByTech[t.id].filter(m=>{if(sd.has(m.id))return false;sd.add(m.id);return true;}); }
  let pulled=0;
  for(const t of TECHS){
    const movable=freshByTech[t.id].filter(m=>inScope(m)).map(m=>({m,e:getMeldAppt(m)})).filter(x=>x.e&&pdtDate(x.e.dtstart)>today&&!isBlockedDay(pdtDate(x.e.dtstart)));
    const movableIds=new Set(movable.map(x=>x.m.id));
    const fixed=buildBusyBlocks(freshByTech[t.id].filter(m=>!movableIds.has(m.id)));
    movable.sort((a,b)=>a.e.dtstart.localeCompare(b.e.dtstart));
    for(const {m,e} of movable){
      const curDate=pdtDate(e.dtstart),curStart=pdtHr(e.dtstart),dur=Math.max(0.5,(new Date(e.dtend)-new Date(e.dtstart))/3600000);
      if(lockedPrefs.has(m.id)){ (fixed[curDate]=fixed[curDate]||[]).push({start:curStart,end:pdtHr(e.dtend)}); continue; }
      const ns=findNextSlot(fixed,dur,today);
      const earlier=ns&&(ns.date<curDate||(ns.date===curDate&&(ns.startHr+ns.startMin/60)<curStart-0.01));
      if(earlier){ const {dtstart,dtend}=slot(ns.date,ns.startHr,ns.startMin,dur); const r=await applyMove(m,dtstart,dtend,sc,csrf);
        if(r.status>=200&&r.status<300){ console.log('  ⇐ Pulled '+m.reference_id+' ('+t.name+') '+curDate+' → '+ns.date+' '+String(ns.startHr).padStart(2,'0')+':'+String(ns.startMin).padStart(2,'0')); await cancelStale(m.id, ns.date, sc, csrf); (fixed[ns.date]=fixed[ns.date]||[]).push({start:ns.startHr+ns.startMin/60,end:ns.startHr+ns.startMin/60+dur}); pulled++; }
        else { console.log('  ✗ compact failed '+m.reference_id+': '+r.status); (fixed[curDate]=fixed[curDate]||[]).push({start:curStart,end:pdtHr(e.dtend)}); }
      } else (fixed[curDate]=fixed[curDate]||[]).push({start:curStart,end:pdtHr(e.dtend)});
    }
  }
  console.log('Compaction: '+pulled+' pulled earlier');
  console.log('=== Done ===');
}
main().catch(e=>{ console.error('FATAL:',e.message); process.exit(1); });
