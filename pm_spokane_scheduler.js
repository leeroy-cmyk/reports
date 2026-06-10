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
  // Spokane group (25113) + Our Natural Homes (25115) treated as same region
  const propObj = (m.unit && m.unit.prop) ? m.unit.prop : m.prop;
  const pg = (propObj && propObj.denormalized_property_groups) || [];
  if (!(pg.includes(SPOKANE_GROUP) || pg.includes(25115))) return false;
  if (m.work_type === 'ENVIRONMENTAL' || m.project) return false;
  // Pest: don't auto-pick up unassigned pest melds — but if already assigned, leave them alone
  if (PEST_PATTERN.test(m.brief_description || '')) {
    return !!(m.in_house_servicers && m.in_house_servicers.length > 0);
  }
  return true;
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

// Extract appointment event from a meld's managementappointment array.
// The list API returns dtstart/dtend directly on the appointment object.
function getMeldAppt(m) {
  for (var i = 0; i < (m.managementappointment||[]).length; i++) {
    var a = m.managementappointment[i];
    if (a.dtstart && a.dtend) return a;
    if (a.availability_segment && a.availability_segment.event && a.availability_segment.event.dtstart) return a.availability_segment.event;
  }
  return null;
}

function pdtDate(iso) {
  var d = new Date(iso);
  var l = new Date(d.toLocaleString('en-US', {timeZone: 'America/Los_Angeles'}));
  return l.getFullYear()+'-'+String(l.getMonth()+1).padStart(2,'0')+'-'+String(l.getDate()).padStart(2,'0');
}

function pdtHr(iso) {
  var d = new Date(iso);
  var l = new Date(d.toLocaleString('en-US', {timeZone: 'America/Los_Angeles'}));
  return l.getHours() + l.getMinutes()/60;
}

function buildBusy(melds) {
  const byDate = {};
  melds.forEach(function(m) {
    var apptEvt = getMeldAppt(m);
    if (!apptEvt) return;
    var date = pdtDate(apptEvt.dtstart);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push({start: pdtHr(apptEvt.dtstart), end: pdtHr(apptEvt.dtend), ref: m.reference_id});
  });
  return byDate;
}

// allowToday: pass true for past-due reschedules so today is a valid slot.
// allowSaturday: pass true only when meld chat explicitly requests Saturday.
function findSlot(busy, durHrs, fromDate, allowToday, allowSaturday) {
  const today = localDate();
  let d = new Date(fromDate+'T12:00:00-07:00');
  for (let i=0; i<28; i++) {
    d.setDate(d.getDate()+1);
    const ds = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    const skipToday = allowToday ? ds < today : ds <= today;
    if (d.getDay()===0 || d.getDay()===1 || (!allowSaturday && d.getDay()===6) || skipToday) continue;
    const b = (busy[ds]||[]).sort(function(a,b){return a.start-b.start;});
    let earliest = 8;
    if (ds === today) {
      const nowLocal = new Date(new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles'}));
      earliest = Math.max(8, nowLocal.getHours() + nowLocal.getMinutes()/60 + 0.5);
    }
    for (let s=earliest; s<=17-durHrs; s+=0.25) {
      const end = s+durHrs;
      if (!b.some(function(x){ return s < x.end+0.5 && end+0.5 > x.start; })) {
        const hr=Math.floor(s), min=Math.round((s-hr)*60);
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
    const dtstart = a.dtstart || (a.availability_segment && a.availability_segment.event && a.availability_segment.event.dtstart);
    const d = dtstart ? pdtDate(dtstart) : null;
    if (d && d !== keepDate) await api('PATCH', '/api/management-appointments/'+a.id+'/cancel/', sc, csrf, {});
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
        // Include: assigned to Wade/Justin OR completely unassigned Spokane repair melds
        if (!isSpokaneRepair(m)) return false;
        var assignedToTeam = m.in_house_servicers && m.in_house_servicers.some(function(s){ return s.agent && (s.agent.id===WADE_ID||s.agent.id===JUSTIN_ID); });
        var unassigned = !m.in_house_servicers || m.in_house_servicers.length===0;
        return assignedToTeam || unassigned;
      });
      melds = melds.concat(filtered);
      if (!d.next||!d.results||!d.results.length) break;
      offset+=200;
    }
  }
  const seen=new Set();
  melds=melds.filter(function(m){if(seen.has(m.id))return false;seen.add(m.id);return true;});

  // Auto-assign unassigned Spokane melds — split between Wade and Justin by current load
  var unassigned = melds.filter(function(m){ return !m.in_house_servicers||!m.in_house_servicers.length; });
  if (unassigned.length) {
    // Count current load to balance
    var wadeCount = melds.filter(function(m){return m.in_house_servicers&&m.in_house_servicers.some(function(s){return s.agent&&s.agent.id===WADE_ID;});}).length;
    var justinCount = melds.filter(function(m){return m.in_house_servicers&&m.in_house_servicers.some(function(s){return s.agent&&s.agent.id===JUSTIN_ID;});}).length;
    for (var ui=0; ui<unassigned.length; ui++) {
      var um = unassigned[ui];
      // Assign to whoever has fewer melds (priority goes to Wade if equal)
      var assignTo = justinCount < wadeCount ? JUSTIN_ID : WADE_ID;
      var assignName = assignTo===WADE_ID ? 'Wade' : 'Justin';
      process.stdout.write('Auto-assigning '+um.reference_id+' to '+assignName+'... ');
      var ra = await api('PATCH','/api/melds/'+um.id+'/assign-maintenance/',sc,csrf,{maintenance:[{id:assignTo,type:'ManagementAgent'}],user_groups:[]});
      console.log(ra.status<300?'OK':'FAIL '+ra.status);
      if (ra.status<300) {
        um.in_house_servicers=[{agent:{id:assignTo,first_name:assignName}}];
        if (assignTo===WADE_ID) wadeCount++; else justinCount++;
      }
    }
  }

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

  // Build busy calendars from ALL assigned melds per tech (not just Spokane repairs)
  // so the scheduler sees their full calendar when finding open slots.
  const allWadeMelds = [], allJustinMelds = [];
  {
    let offset = 0;
    while (true) {
      const r = await api('GET', '/api/melds/?limit=200&offset='+offset+'&status=PENDING_COMPLETION', sc, csrf);
      const d = JSON.parse(r.body);
      (d.results||[]).forEach(function(m) {
        if (m.in_house_servicers && m.in_house_servicers.some(function(s){return s.agent&&s.agent.id===WADE_ID;})) allWadeMelds.push(m);
        if (m.in_house_servicers && m.in_house_servicers.some(function(s){return s.agent&&s.agent.id===JUSTIN_ID;})) allJustinMelds.push(m);
      });
      if (!d.next || !(d.results||[]).length) break;
      offset += 200;
    }
    console.log('Full calendar: Wade='+allWadeMelds.length+' Justin='+allJustinMelds.length+' scheduled melds');
  }
  const wadeBusy   = buildBusy(allWadeMelds);
  const justinBusy = buildBusy(allJustinMelds);

  const RESCHEDULE_KW = /reschedule|different (time|day|date)|can'?t make|not available|won'?t be home|conflict|push|postpone/i;
  const ACCOMMODATE_KW = /available (at|after|before|on)|prefer|better (time|day)|can (you|we) (come|do it)|i'?ll be home|good time|works for me|please come/i;
  const DURATION_KW = /(\d+)\s*(min|minute|minutes|hr|hour)/i;
  const TIME_KW = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
  const DAY_KW = /\b(monday|tuesday|wednesday|thursday|friday|mon|tue|wed|thu|fri)\b/i;

  function parseChatAction(messages, apptCreated) {
    // Only look at messages newer than the current appointment (or last 48h if no appt)
    const cutoff = apptCreated ? new Date(apptCreated) : new Date(Date.now()-48*3600000);
    const fresh = messages.filter(function(msg){ return msg.created && new Date(msg.created) > cutoff; });
    if (!fresh.length) return null;
    // Most recent first
    const sorted = fresh.slice().sort(function(a,b){ return b.created.localeCompare(a.created); });
    for (let i=0; i<Math.min(sorted.length,8); i++) {
      const msg = sorted[i];
      const text = msg.text || '';
      const isTenant = !!(msg.tenant) || msg.clazz === 't';
      const isAgent  = !!(msg.agent)  || msg.clazz === 'm';
      const sender = msg.tenant ? ((msg.tenant.first_name||'')+' '+(msg.tenant.last_name||'')).trim()
                   : msg.agent  ? ((msg.agent.user&&msg.agent.user.first_name||'')+' '+(msg.agent.user&&msg.agent.user.last_name||'')).trim()
                   : (msg.commenter_name||'unknown');
      const msgDate = (msg.created||'').slice(0,10);
      // Duration hint from agent
      const durMatch = DURATION_KW.exec(text);
      if (durMatch && isAgent) {
        const num = parseFloat(durMatch[1]);
        const unit = durMatch[2].toLowerCase();
        const hrs = unit.startsWith('h') ? num : num/60;
        return {action:'shorten', durationHrs:hrs, note:text.slice(0,80), sender:sender, msgDate:msgDate};
      }
      // Reschedule request
      if (RESCHEDULE_KW.test(text)) {
        const dayM = DAY_KW.exec(text), timeM = TIME_KW.exec(text);
        return {action:'reschedule', requestedDay:dayM?dayM[1]:null, requestedTime:timeM?timeM[0]:null, isTenant:isTenant, note:text.slice(0,80), sender:sender, msgDate:msgDate};
      }
      // Resident time preference
      if (isTenant && ACCOMMODATE_KW.test(text)) {
        const dayM = DAY_KW.exec(text), timeM = TIME_KW.exec(text);
        return {action:'accommodate_resident', requestedDay:dayM?dayM[1]:null, requestedTime:timeM?timeM[0]:null, note:text.slice(0,80), sender:sender, msgDate:msgDate};
      }
    }
    return null;
  }

  function nextDayOccurrence(dayName, afterDate) {
    const DAYS = {monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,sunday:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6,sun:0};
    const target = DAYS[dayName.toLowerCase()];
    if (target===undefined) return null;
    // Weekends allowed if explicitly requested in chat
    const isWeekend = target===0||target===6;
    let d = new Date(afterDate+'T12:00:00-07:00');
    for (let i=0; i<14; i++) {
      d.setDate(d.getDate()+1);
      if (d.getDay()===target && (isWeekend || (d.getDay()!==1 && d.getDay()!==0 && d.getDay()!==6))) {
        return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      }
    }
    return null;
  }

  const toSchedule = [];

  for (let mi=0; mi<melds.length; mi++) {
    const m = melds[mi];
    var apptEvt = getMeldAppt(m);
    var isPastDue = apptEvt && pdtDate(apptEvt.dtstart) < today;
    var isUnscheduled = !apptEvt;
    const isWade = m.in_house_servicers && m.in_house_servicers.some(function(s){return s.agent&&s.agent.id===WADE_ID;});

    // Read chat for ALL melds — check for requests even on already-scheduled ones
    var chatAction = null;
    try {
      const rc = await api('GET', '/api/comments/?meld='+m.id+'&limit=50&ordering=created', sc, csrf);
      if (rc.status===200) {
        var msgs = JSON.parse(rc.body);
        if (!Array.isArray(msgs)) msgs = msgs.results||[];
        var apptCreated = (m.managementappointment||[]).map(function(a){return a.created;}).filter(Boolean)[0]||null;
        chatAction = parseChatAction(msgs, apptCreated);
        if (chatAction) console.log(m.reference_id+' chat action detected: '+chatAction.action+' from '+chatAction.sender+': '+chatAction.note);
      }
    } catch(e) { /* no chat */ }

    // Decide: chat requests override schedule status; past-due/unscheduled are fallbacks
    if (chatAction && (chatAction.action==='reschedule'||chatAction.action==='accommodate_resident')) {
      toSchedule.push({m:m, reason:'chat ('+chatAction.sender+'): '+chatAction.note.slice(0,50), isWade:isWade, chatAction:chatAction});
    } else if (chatAction && chatAction.action==='shorten' && apptEvt) {
      const curDur = (new Date(apptEvt.dtend)-new Date(apptEvt.dtstart))/3600000;
      if (curDur > chatAction.durationHrs+0.1) {
        toSchedule.push({m:m, reason:'shorten to '+chatAction.durationHrs+'h per '+chatAction.sender, isWade:isWade, chatAction:chatAction, shorten:true});
      }
    } else if (isPastDue) {
      toSchedule.push({m:m, reason:'past-due ('+apptEvt.dtstart.slice(0,10)+')', isWade:isWade});
    } else if (isUnscheduled) {
      toSchedule.push({m:m, reason:'unscheduled', isWade:isWade});
    }
  }

  // Sort by priority
  toSchedule.sort(function(a,b){return (PRI[a.m.priority]||2)-(PRI[b.m.priority]||2);});
  console.log('Need scheduling: '+toSchedule.length);

  for (let ti=0; ti<toSchedule.length; ti++) {
    const item = toSchedule[ti];
    const m = item.m;
    const ca = item.chatAction;
    const busy = item.isWade ? wadeBusy : justinBusy;
    const techName = item.isWade ? 'Wade' : 'Justin';

    // For shorten: keep same date, just trim end time
    if (item.shorten && ca) {
      var evt = getMeldAppt(m);
      if (evt) {
        var sameDay = pdtDate(evt.dtstart);
        var lStart = new Date(new Date(evt.dtstart).toLocaleString('en-US',{timeZone:'America/Los_Angeles'}));
        var startHr = lStart.getHours();
        var startMin = lStart.getMinutes();
        const times = slotStr(sameDay, startHr, startMin, ca.durationHrs);
        process.stdout.write(m.reference_id+' ['+m.priority+'] '+techName+' shorten to '+ca.durationHrs+'h same day... ');
        const r = await schedMeld(m.id, times.dtstart, times.dtend, m.started, sc, csrf);
        console.log(r.status<300?'OK':'FAIL '+r.status+' '+r.body.slice(0,80));
      }
      continue;
    }

    var dur = estimateDuration(m.brief_description);
    if (ca && ca.action==='shorten') dur = ca.durationHrs;

    // Try to honor requested day/time from chat
    var slot = null;
    if (ca && ca.requestedDay) {
      const prefDay = nextDayOccurrence(ca.requestedDay, today);
      if (prefDay) {
          var chatWantsSat = /saturday|sat\b/i.test(ca.requestedDay||'') || /saturday|sat\b/i.test(ca.note||'');
        const candidate = findSlot(Object.assign({},busy), dur, new Date(prefDay+'T12:00:00-07:00').toISOString().slice(0,10), false, chatWantsSat);
        if (candidate && candidate.date===prefDay) { slot=candidate; console.log('  Honoring chat day request: '+prefDay); }
      }
    }
    var isPastDueAction = (item.reason||'').indexOf('past-due') >= 0;
    var chatWantsSatMain = ca && (/saturday|sat\b/i.test(ca.requestedDay||'') || /saturday|sat\b/i.test(ca.note||''));
    if (!slot) slot = findSlot(busy, dur, today, isPastDueAction, chatWantsSatMain);
    if (!slot) { console.log('No slot for '+m.reference_id); continue; }
    const times = slotStr(slot.date, slot.startHr, slot.startMin, dur);
    // Cancel phantom appointments before scheduling
    for (var pi=0; pi<(m.managementappointment||[]).length; pi++) {
      var pa = m.managementappointment[pi];
      if (!pa.availability_segment || !pa.availability_segment.event) {
        await api('PATCH', '/api/management-appointments/'+pa.id+'/cancel/', sc, csrf, {});
        console.log('  Cleared phantom appt '+pa.id+' on '+m.reference_id);
      }
    }
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
    var ea = getMeldAppt(a), eb = getMeldAppt(b);
    return (ea?ea.dtstart:'zzz').localeCompare(eb?eb.dtstart:'zzz');
  });
  melds.forEach(function(m) {
    var apptEvt = getMeldAppt(m);
    var tech = m.in_house_servicers && m.in_house_servicers.map(function(s){return s.agent&&s.agent.first_name;}).filter(Boolean).join('+');
    var apptStr = apptEvt ? fmt(apptEvt.dtstart) : 'NO APPT';
    var pd = apptEvt && pdtDate(apptEvt.dtstart) < today;
    var flag = pd?' PAST-DUE':(!apptEvt?' UNSCHEDULED':'');
    console.log((m.reference_id||'').padEnd(11)+'|'+(m.priority||'?').padEnd(9)+'|'+(tech||'?').padEnd(8)+'|'+(m.brief_description||'').slice(0,30).padEnd(31)+'| '+apptStr+flag);
  });
}
main().catch(function(e){console.error('FATAL:',e.message);});
