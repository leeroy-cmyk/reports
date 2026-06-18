#!/usr/bin/env node
/**
 * PropertyMeld tc68/tc34 Scheduler
 * Runs automatically once daily via GitHub Actions (.github/workflows/pm-scheduler.yml, 6am PDT).
 * Checks Jonas Hoard's work orders, reads chats, reschedules as needed.
 * Self-heals: schedules unscheduled melds, moves past-due forward, relocates anything
 * landing on a reserved day (Mon/weekend), and spreads out double-booked appointments.
 * Set DRY_RUN=1 to preview without writing.
 */

const https = require('https');
const fs = require('fs');
const { analyzeChat } = require('./pm_chat_llm'); // LLM chat reader; no-ops to null without ANTHROPIC_API_KEY
const BASE = 'https://app.propertymeld.com', MGMT = '2975';
const JONAS_ID = 59983;
const ARMANI_ID = 59985; // Armani Mitchell — handles Tacoma TURNS. Jonas + Armani are the only Tacoma techs.
const LOG_FILE = process.env.PM_LOG_FILE || null; // set to a path to persist logs; omit in CI
const DRY = !!process.env.DRY_RUN; // preview mode: log intended writes without PATCHing

// ── HELPERS ──────────────────────────────────────────────────────────────────

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
  const csrf1 = (r1.body.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/) || [])[1];
  const bd = new URLSearchParams({csrfmiddlewaretoken:csrf1, email:process.env.PROPERTYMELD_EMAIL, password:process.env.PROPERTYMELD_PASSWORD}).toString();
  const r2 = await httpreq('POST', BASE+'/login/?next=/', {'User-Agent':'Mozilla/5.0','Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(bd),'Referer':BASE+'/login/?next=/','Cookie':sc()}, bd);
  add(r2.headers);
  const r3 = await httpreq('GET', BASE+'/'+MGMT+'/m/'+MGMT+'/dashboard/', {'User-Agent':'Mozilla/5.0','Cookie':sc()});
  add(r3.headers);
  const csrfMatch = r3.body.match(/window\.PM\.csrf_token\s*=\s*"([^"]+)"/);
  return {sc, csrf: csrfMatch ? csrfMatch[1] : ''};
}

async function apiGet(path, sc, csrf) {
  const h = {'User-Agent':'Mozilla/5.0','Cookie':sc(),'X-CSRFToken':csrf,'Accept':'application/json','Referer':BASE+'/'+MGMT+'/m/'+MGMT+'/'};
  return httpreq('GET', BASE+'/'+MGMT+'/m/'+MGMT+path, h, null);
}

async function apiPatch(path, sc, csrf, body) {
  if (DRY) { console.log('   [DRY] would PATCH '+path); return {status:200, body:'{}'}; }
  const bodyStr = JSON.stringify(body);
  const h = {'User-Agent':'Mozilla/5.0','Cookie':sc(),'X-CSRFToken':csrf,'Accept':'application/json','Content-Type':'application/json','Content-Length':Buffer.byteLength(bodyStr),'Referer':BASE+'/'+MGMT+'/m/'+MGMT+'/'};
  return httpreq('PATCH', BASE+'/'+MGMT+'/m/'+MGMT+path, h, bodyStr);
}

function slot(date, startHr, startMin, durationHrs) {
  const pad = n => String(n).padStart(2,'0');
  const totalMins = startHr * 60 + startMin + Math.round(durationHrs * 60);
  const endHr = Math.floor(totalMins / 60);
  const endMin = totalMins % 60;
  return {
    dtstart: `${date}T${pad(startHr)}:${pad(startMin)}:00-07:00`,
    dtend:   `${date}T${pad(endHr)}:${pad(endMin)}:00-07:00`,
  };
}

function localDate(daysFromNow = 0) {
  const d = new Date();
  d.setTime(d.getTime() + daysFromNow * 86400000);
  const pdt = new Date(d.toLocaleString('en-US', {timeZone: 'America/Los_Angeles'}));
  return pdt.getFullYear()+'-'+String(pdt.getMonth()+1).padStart(2,'0')+'-'+String(pdt.getDate()).padStart(2,'0');
}

function isMon(dateStr) {
  return new Date(dateStr+'T12:00:00-07:00').getDay() === 1;
}

// Sunday(0), Monday(1), Saturday(6) are reserved — nothing should be scheduled on them
function isBlockedDay(dateStr) {
  const d = new Date(dateStr+'T12:00:00-07:00').getDay();
  return d === 0 || d === 1 || d === 6;
}

// Find next available date (skip Mondays, start from tomorrow)
function nextAvailableDate(afterDate, skipDates = []) {
  let d = new Date(afterDate+'T12:00:00-07:00');
  d.setDate(d.getDate() + 1);
  for (let i = 0; i < 30; i++) {
    const ds = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    if (d.getDay() !== 0 && d.getDay() !== 1 && d.getDay() !== 6 && !skipDates.includes(ds)) return ds;
    d.setDate(d.getDate() + 1);
  }
  return null;
}

// ── CHAT PARSING ─────────────────────────────────────────────────────────────

function parseSchedulingRequest(messages, meldBrief) {
  // Returns { action, requestedDate, requestedTime, durationHint, note } or null
  // action: 'reschedule' | 'accommodate_resident' | 'shorten' | null

  const RESCHEDULE_KEYWORDS = /reschedule|different (time|day|date)|can'?t make|not available|won'?t be home|conflict|postpone|push (it|this) back|move (it|this|that) (up|back)|(schedule|come|get|fix)\s+\w*\s*(earlier|sooner)|earlier than|something earlier|any earlier|come (in )?sooner|before (mon|tue|wed|thu|fri|sat|sun|noon)/i;
  const ACCOMMODATE_KEYWORDS = /available (at|after|before|on)|prefer|better (time|day)|can (you|we) (come|do it)|i'?ll be home|good time|works for me|please come|sometime (on|around)/i;
  const SHORTEN_KEYWORDS = /(\d+)\s*(min|minute|minutes|hr|hour)/i;
  const TIME_PATTERN = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
  const DAY_PATTERN = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|weekday|weekend)\b/i;
  const NEXT_PATTERN = /\bnext\s+(week|monday|tuesday|wednesday|thursday|friday)\b/i;

  // Sort messages by created desc — look at most recent ones first
  const sorted = [...messages].sort((a,b) => b.created.localeCompare(a.created));
  const recent = sorted.slice(0, 10); // look at last 10 messages

  for (const msg of recent) {
    const text = msg.text || '';
    const isFromTenant = !!msg.tenant || msg.clazz === 't';
    const isFromAgent = !!msg.agent || msg.clazz === 'm';
    const senderName = msg.tenant ? ((msg.tenant.first_name||'')+' '+(msg.tenant.last_name||'')).trim()
                     : msg.agent  ? ((msg.agent.user?.first_name||'')+' '+(msg.agent.user?.last_name||'')).trim()
                     : (msg.commenter_name || 'unknown');
    const when = msg.created.slice(0,10);

    // Check for duration hint (e.g., "15 minutes", "2 hours")
    const durationMatch = SHORTEN_KEYWORDS.exec(text);
    if (durationMatch && isFromAgent) {
      const num = parseFloat(durationMatch[1]);
      const unit = durationMatch[2].toLowerCase();
      const hrs = unit.startsWith('h') ? num : num / 60;
      return { action: 'shorten', durationHrs: hrs, note: text, sender: senderName, msgDate: when };
    }

    // Check for reschedule request
    if (RESCHEDULE_KEYWORDS.test(text)) {
      const dayMatch = DAY_PATTERN.exec(text);
      const timeMatch = TIME_PATTERN.exec(text);
      const nextMatch = NEXT_PATTERN.exec(text);
      // "earlier/sooner/before X / not X" = move to the EARLIEST slot — the day mentioned is
      // the one to AVOID, not a target. Don't capture it as a requested day/time.
      const earlier = /earlier|sooner|before (mon|tue|wed|thu|fri|sat|sun|noon)|no later than|not (on )?(mon|tue|wed|thu|fri|sat|sun)/i.test(text);
      return {
        action: 'reschedule',
        requestedDay: earlier ? null : (dayMatch ? dayMatch[1] : null),
        requestedTime: earlier ? null : (timeMatch ? timeMatch[0] : null),
        nextWeek: !earlier && !!nextMatch,
        isFromTenant,
        note: text,
        sender: senderName,
        msgDate: when
      };
    }

    // Check for resident time preference
    if (isFromTenant && ACCOMMODATE_KEYWORDS.test(text)) {
      const timeMatch = TIME_PATTERN.exec(text);
      const dayMatch = DAY_PATTERN.exec(text);
      return {
        action: 'accommodate_resident',
        requestedDay: dayMatch ? dayMatch[1] : null,
        requestedTime: timeMatch ? timeMatch[0] : null,
        note: text,
        sender: senderName,
        msgDate: when
      };
    }
  }
  return null;
}

// Parse a time string like "3pm", "10:30am" to {hr, min}
function parseTime(timeStr) {
  if (!timeStr) return null;
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(timeStr);
  if (!m) return null;
  let hr = parseInt(m[1]);
  const min = parseInt(m[2] || '0');
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && hr < 12) hr += 12;
  if (ampm === 'am' && hr === 12) hr = 0;
  return {hr, min};
}

// Parse a day name to the next occurrence of that day (PDT)
function nextOccurrenceOfDay(dayName, afterDate) {
  const DAYS = {sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6,saturday:6,sat:6};
  const targetDay = DAYS[dayName.toLowerCase()];
  if (targetDay === undefined) return null;
  // Saturday (6) and Sunday (0) are normally blocked, but if explicitly requested in chat — allow it
  const isWeekend = targetDay === 0 || targetDay === 6;
  let d = new Date(afterDate+'T12:00:00-07:00');
  d.setDate(d.getDate() + 1);
  for (let i = 0; i < 14; i++) {
    if (d.getDay() === targetDay && (isWeekend || d.getDay() !== 1)) {
      return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    }
    d.setDate(d.getDate() + 1);
  }
  return null;
}

// ── PREFERENCE LOCK ──────────────────────────────────────────────────────────
// A specific day/time/date stated in the work-order TITLE or CHAT is a hard preference:
// schedule to it and never let compaction move it.
const MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
function extractPreference(text) {
  if (!text) return null;
  const t = String(text);
  const dayName = (t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)||[])[1] || null;
  const time = (t.match(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i)||[])[0] || null;
  let dateStr = null;
  const mon = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  const mdy = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (mon) { const mm=MONTHS[mon[1].toLowerCase()]; const dd=parseInt(mon[2]); if(mm&&dd>=1&&dd<=31) dateStr='2026-'+String(mm).padStart(2,'0')+'-'+String(dd).padStart(2,'0'); }
  else if (mdy) { const mm=parseInt(mdy[1]), dd=parseInt(mdy[2]); if(mm>=1&&mm<=12&&dd>=1&&dd<=31) dateStr='2026-'+String(mm).padStart(2,'0')+'-'+String(dd).padStart(2,'0'); }
  if (!dayName && !time && !dateStr) return null;
  return { dayName, time, dateStr };
}
// Keep only honorable parts: drop a date that's already in the past.
function usablePreference(pref, today) {
  if (!pref) return null;
  // Keep a stated date if it's today or future (a "June 18th" task should be done ON the 18th,
  // even though the scheduler normally skips today). Past dates can't be honored → dropped.
  const out = { dayName: pref.dayName || null, time: pref.time || null, dateStr: (pref.dateStr && pref.dateStr >= today) ? pref.dateStr : null };
  return (out.dayName || out.time || out.dateStr) ? out : null;
}
// Does an existing appointment already satisfy the preference?
function apptMatchesPref(apptEvt, pref) {
  if (!apptEvt || !pref) return false;
  const d = apptEvt.dtstart.slice(0,10);
  if (pref.dateStr && d !== pref.dateStr) return false;
  if (pref.dayName) {
    const DAYS = {sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6};
    if (new Date(d+'T12:00:00-07:00').getDay() !== DAYS[pref.dayName.toLowerCase()]) return false;
  }
  if (pref.time) { const pt = parseTime(pref.time); if (pt && Math.abs(pdtHr(apptEvt.dtstart) - (pt.hr+pt.min/60)) > 0.01) return false; }
  return true;
}
// First free slot ON a specific date (8am–5pm), or null if that day is full.
function findSlotOnDate(busyBlocks, durationHrs, dateStr, bufferHrs = 0.5, minStart = 8) {
  const busy = (busyBlocks[dateStr]||[]).sort((a,b)=>a.start-b.start);
  for (let s=Math.max(8,minStart); s<=17-durationHrs; s+=0.25) {
    const e=s+durationHrs;
    if (!busy.some(b => s < b.end+bufferHrs && e+bufferHrs > b.start)) return {date:dateStr, startHr:Math.floor(s), startMin:Math.round((s-Math.floor(s))*60), durationHrs};
  }
  return null;
}
// Build the slot a preference points to. A stated date that is TODAY is honored same-day
// (from the next quarter-hour after now) — the only case where today is schedulable.
function preferredSlot(pref, durationHrs, busyBlocks, today, bufferHrs = 0.5) {
  let date = pref.dateStr || (pref.dayName ? nextOccurrenceOfDay(pref.dayName, today) : null);
  if (!date || date < today) date = nextAvailableDate(today); // past/none → next open day
  if (!date) return null;
  const isToday = date === today;
  const minStart = isToday ? Math.min(16, Math.ceil((pdtHr(new Date().toISOString()) + 0.5) * 4) / 4) : 8;
  const pt = pref.time ? parseTime(pref.time) : null;
  if (pt) {
    const start = pt.hr + pt.min/60, end = start + durationHrs;
    const busy = busyBlocks[date] || [];
    const conflict = busy.some(b => start < b.end + bufferHrs && end + bufferHrs > b.start);
    if (start >= minStart && end <= 17 && !conflict) return {date, startHr:pt.hr, startMin:pt.min, durationHrs}; // honor exact requested time
  }
  // Requested time taken/invalid → first free slot that day, else next available day
  return findSlotOnDate(busyBlocks, durationHrs, date, bufferHrs, minStart) || findNextSlot(busyBlocks, durationHrs, today);
}

// ── SCHEDULING LOGIC ─────────────────────────────────────────────────────────

const PRIORITY_ORDER = {Emergency:0, Urgent:0, High:1, Normal:2, Medium:2, Low:3};

// Duration estimates based on brief description keywords (hours)
function estimateDuration(brief) {
  const b = (brief || '').toLowerCase();
  // 30-min photo/quick tasks (confirmed by management notes)
  if (/lawn maintenance|litter pick|office cleaning|internal office/.test(b)) return 0.5;
  // Other quick tasks
  if (/photo|picture|walkthrough|estimate|pet waste/.test(b)) return 0.5;
  if (/key|lock|mailbox|bulb|filter/.test(b)) return 1;
  if (/inspection|check|verify|lighting check/.test(b)) return 1.5;
  if (/leak|water|plumb|toilet|drain|flood/.test(b)) return 2;
  if (/paint|drywall|patch|hole|ceiling/.test(b)) return 3;
  if (/appliance|stove|refrigerator|hvac|heat|ac/.test(b)) return 2;
  if (/bed weed|weed|fertiliz/.test(b)) return 2;
  if (/safety|quarterly/.test(b)) return 2;
  if (/irrigation/.test(b)) return 1;
  return 1.5; // default
}

// ── CALENDAR BUILDER ─────────────────────────────────────────────────────────

// Convert an ISO datetime to PDT decimal hours (e.g. 9.5 = 9:30am)
function pdtHr(iso) {
  const d = new Date(iso);
  return ((d.getUTCHours() - 7 + 24) % 24) + d.getUTCMinutes() / 60;
}

// Find meld ids whose appointment overlaps a higher/equal-priority appointment on the
// same day → the lower-priority/later one should be relocated. Considers the tech's
// ENTIRE calendar (turns included) so repairs don't sit on top of a full-day turn.
function findOverlaps(allMelds) {
  const overlapIds = new Set();
  const byDate = {};
  allMelds.forEach(m => {
    const e = m.managementappointment?.find(a => a.availability_segment?.event)?.availability_segment?.event;
    if (!e) return;
    const d = e.dtstart.slice(0, 10);
    (byDate[d] = byDate[d] || []).push({ m, start: pdtHr(e.dtstart), end: pdtHr(e.dtend) });
  });
  for (const d in byDate) {
    const list = byDate[d].sort((a, b) =>
      (PRIORITY_ORDER[a.m.priority] ?? 2) - (PRIORITY_ORDER[b.m.priority] ?? 2) || a.start - b.start);
    const kept = [];
    for (const it of list) {
      if (kept.some(k => it.start < k.end && it.end > k.start)) overlapIds.add(it.m.id);
      else kept.push(it);
    }
  }
  return overlapIds;
}

// Build busy time blocks from existing scheduled melds
function buildBusyBlocks(melds) {
  const byDate = {};
  melds.forEach(m => {
    const appt = m.managementappointment?.find(a => a.availability_segment?.event);
    if (!appt) return;
    const evt = appt.availability_segment.event;
    const date = evt.dtstart.slice(0,10);
    if (!byDate[date]) byDate[date] = [];
    // Use pdtHr (wraps mod 24) so appts ending at/after midnight UTC (5pm+ PDT) don't
    // produce a negative end-hour that hides the block and causes double-booking.
    byDate[date].push({start: pdtHr(evt.dtstart), end: pdtHr(evt.dtend)});
  });
  return byDate;
}

// Find next open slot for a given duration, starting from a date
// Returns {date, startHr, startMin} or null
function findNextSlot(busyBlocks, durationHrs, startingFrom, bufferHrs = 0.5) {
  const today = localDate();
  let d = new Date(startingFrom+'T12:00:00-07:00');

  for (let i = 0; i < 21; i++) {
    const dateStr = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    // Skip Mondays and today
    if (d.getDay() === 0 || d.getDay() === 1 || d.getDay() === 6 || dateStr <= today) { d.setDate(d.getDate()+1); continue; }

    const busy = (busyBlocks[dateStr] || []).sort((a,b)=>a.start-b.start);
    // Pack the nearest day densely from 8am: take the first non-conflicting slot.
    // (No morning-reserve gap — fill closer days fully before scheduling further out.)
    for (let slot = 8; slot <= 17 - durationHrs; slot += 0.25) {
      const slotEnd = slot + durationHrs;
      const conflicts = busy.some(b => slot < b.end + bufferHrs && slotEnd + bufferHrs > b.start);
      if (!conflicts && slotEnd <= 17) {
        const startHr = Math.floor(slot);
        const startMin = Math.round((slot - startHr) * 60);
        return {date: dateStr, startHr, startMin, durationHrs};
      }
    }
    d.setDate(d.getDate()+1);
  }
  return null;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const runAt = new Date().toISOString();
  const actions = [];
  const log = msg => { console.log(msg); actions.push({time: new Date().toISOString(), msg}); };

  log('=== PM Scheduler run: '+runAt+' ===');

  let sc, csrf;
  try {
    ({sc, csrf} = await login());
    log('Logged in OK');
  } catch(e) {
    log('LOGIN FAILED: '+e.message);
    process.exit(1);
  }

  // 1. Get all open tc68/tc34 melds — both Jonas-assigned AND unassigned non-project repair melds
  const statuses = ['PENDING_ASSIGNMENT','PENDING_MORE_MANAGEMENT_AVAILABILITY','PENDING_COMPLETION'];
  let melds = [];
  let jonasAll = []; // ALL melds assigned to Jonas (incl. turns) — for busy-block awareness
  for (const s of statuses) {
    let offset = 0;
    while(true) {
      const r = await apiGet('/api/melds/?limit=200&offset='+offset+'&status='+s, sc, csrf);
      const d = JSON.parse(r.body);
      const tc = (d.results||[]).filter(m => {
        const propObj = (m.unit && m.unit.prop) ? m.unit.prop : m.prop;
        const prop = (propObj?.property_name || '').toLowerCase();
        // Jonas handles ALL work types at tc68/tc34 (incl. ENVIRONMENTAL grounds melds).
        // Only turns (project melds) are excluded — those go to Armani.
        return (prop.startsWith('tc68') || prop.startsWith('tc34')) && !m.project;
      });
      melds.push(...tc);
      // Capture every Jonas-assigned meld (any property, any type incl. turns) so busy
      // blocks reflect his FULL calendar — otherwise turn melds (e.g. Trash Out spanning
      // a full workday) are invisible and the scheduler double-books on top of them.
      jonasAll.push(...(d.results||[]).filter(m => m.in_house_servicers?.some(srv => srv.agent?.id === JONAS_ID)));
      if (!d.next || !d.results?.length) break;
      offset += 200;
    }
  }
  const seen = new Set(); melds = melds.filter(m=>{if(seen.has(m.id))return false;seen.add(m.id);return true;});
  const seenAll = new Set(); jonasAll = jonasAll.filter(m=>{if(seenAll.has(m.id))return false;seenAll.add(m.id);return true;});

  // Assign tc68/tc34 non-turn melds to Jonas when they're either unassigned OR assigned to
  // a tech who doesn't work Tacoma. Only Jonas + Armani work Tacoma; anyone else (e.g.
  // Margarito Saldana = Tri-Cities) on a non-turn meld here is a mis-assignment → give to Jonas.
  // Leave Armani-assigned melds alone (he owns turn-prep). Skip pest control.
  const PEST_RE = /pest|bed.?bug|termite|rodent|mice|mouse|trap|exterminate|infest/i;
  for (const m of melds) {
    const hasJonas  = m.in_house_servicers?.some(s => s.agent?.id === JONAS_ID);
    const hasArmani = m.in_house_servicers?.some(s => s.agent?.id === ARMANI_ID);
    const hasAnyTech = m.in_house_servicers?.length > 0;
    if (hasJonas || hasArmani || PEST_RE.test(m.brief_description||'')) continue;
    if (!hasAnyTech || !(hasJonas || hasArmani)) {
      const others = (m.in_house_servicers||[]).map(s => ((s.agent?.first_name||'')+' '+(s.agent?.last_name||'')).trim()).filter(Boolean);
      log((hasAnyTech ? 'Reassigning '+m.reference_id+' to Jonas (was on non-Tacoma tech: '+others.join(', ')+')'
                      : 'Auto-assigning '+m.reference_id+' to Jonas (was unassigned)'));
      const ra = await apiPatch('/api/melds/'+m.id+'/assign-maintenance/', sc, csrf,
        {maintenance:[{id:JONAS_ID,type:'ManagementAgent'}],user_groups:[]});
      if (ra.status < 300) {
        m.in_house_servicers = [{agent:{id:JONAS_ID,first_name:'Jonas',last_name:'Hoard'}}];
      } else {
        log('  Failed to assign: '+ra.status);
      }
    }
  }

  // Keep only Jonas melds for scheduling
  melds = melds.filter(m => m.in_house_servicers?.some(s => s.agent?.id === JONAS_ID));
  log('Jonas tc68/tc34 melds: '+melds.length);

  const today = localDate();
  // Busy blocks from Jonas's ENTIRE calendar (turns included), not just the schedulable subset.
  const busyBlocks = buildBusyBlocks(jonasAll);
  // Detect double-booked appointments across his whole calendar; the loser of each
  // overlap gets relocated below. Build busy blocks BEFORE this so the kept appts
  // remain reserved and the relocated one finds a genuinely free slot.
  const overlapIds = findOverlaps(jonasAll);
  if (overlapIds.size) log('Overlapping appointments to relocate: '+overlapIds.size);
  // Preference locks: meld id → {dayName,time,dateStr} parsed from title/chat. Populated in
  // the loop below (chat is fetched there) and honored by both the loop and the compaction pass.
  const lockedPrefs = new Map();

  // 2. Process each meld
  for (const m of melds) {
    const ref = m.reference_id;
    const brief = m.brief_description || '';
    const priority = m.priority || 'Normal';

    // Get current appointment
    const appt = m.managementappointment?.find(a => a.availability_segment?.event);
    const apptEvt = appt?.availability_segment?.event;
    const apptId = appt?.id;

    // Check if past-due — appointment date is strictly before today (not today, not future)
    // Using date comparison instead of 2-hour window to catch anything from yesterday or earlier
    const apptEndTime = apptEvt ? new Date(apptEvt.dtend) : null;
    const apptDate = apptEvt ? apptEvt.dtstart.slice(0,10) : null;
    const isPastDue = apptEvt && apptDate < today && m.status !== 'COMPLETED';

    // Check if unscheduled
    const isUnscheduled = !apptEvt;

    // Get chat messages — always check for ALL melds, scheduled or not
    let messages = [];
    try {
      const rc = await apiGet('/api/comments/?meld='+m.id+'&limit=50&ordering=created', sc, csrf);
      if (rc.status === 200) messages = JSON.parse(rc.body);
      if (!Array.isArray(messages)) messages = messages.results || [];
    } catch(e) { /* no chat */ }

    // Which chat messages are actionable depends on whether the meld is already scheduled:
    const apptCreated = appt?.created || null;
    const RECENCY_MS = 26 * 3600000; // > 24h run cadence
    let newMessages;
    if (apptEvt) {
      // ALREADY SCHEDULED: only act on messages newer than the appointment AND within ~26h.
      // Rescheduling keeps the same appointment record (apptCreated doesn't advance), so
      // without the recency cap an old "please reschedule" note would re-fire every run (thrash).
      const cutoff = apptCreated ? new Date(apptCreated).getTime() : (Date.now() - RECENCY_MS);
      newMessages = messages.filter(msg => msg.created
        && new Date(msg.created).getTime() > cutoff
        && (Date.now() - new Date(msg.created).getTime()) < RECENCY_MS);
    } else {
      // NOT YET SCHEDULED: honor any resident preferred-date / scheduling note from the last
      // 30 days. No thrash risk — once placed the meld has an appointment and won't reset.
      const cutoff = Date.now() - 30 * 86400000;
      newMessages = messages.filter(msg => msg.created && new Date(msg.created).getTime() > cutoff);
    }

    // Read the chat like a coordinator via the LLM (full recent thread); fall back to the
    // keyword parser when the LLM is unavailable. The LLM sees the CURRENT appointment and
    // flags already-satisfied requests itself — that's what prevents re-acting every run.
    let chatAction = null, llm = null;
    const apptStrPDT = apptEvt ? new Date(apptEvt.dtstart).toLocaleString('en-US',{timeZone:'America/Los_Angeles',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : null;
    const recentChat = messages.some(x => x.created && (Date.now() - new Date(x.created).getTime()) < 21*86400000);
    if (recentChat) llm = await analyzeChat(brief, messages, apptStrPDT, today);
    if (llm) {
      if (llm.intent !== 'none') {
        chatAction = llm.earlier
          ? { action:'reschedule', requestedDay:null, requestedTime:null, note: llm.reasoning, sender:'chat(LLM)', msgDate: today }
          : { action:'accommodate_resident', requestedDay: (llm.pref&&llm.pref.dayName)||null, requestedTime: (llm.pref&&llm.pref.time)||null, note: llm.reasoning, sender:'chat(LLM)', msgDate: today };
      }
    } else {
      chatAction = newMessages.length > 0 ? parseSchedulingRequest(newMessages, brief) : null;
    }

    // Preference lock: a specific day/time/date in the TITLE, the LLM's structured pref, or
    // (fallback) a day/time the keyword parser extracted from a real request.
    let pref = usablePreference(extractPreference(brief), today);
    if (!pref && llm && llm.pref) pref = usablePreference(llm.pref, today);
    if (!pref && chatAction && (chatAction.requestedDay || chatAction.requestedTime)) {
      pref = usablePreference({ dayName: chatAction.requestedDay || null, time: chatAction.requestedTime || null, dateStr: null }, today);
    }
    if (pref) lockedPrefs.set(m.id, pref);

    // Decide what to do
    let action = null;
    let reason = '';

    if (pref && (isUnscheduled || isPastDue || !apptMatchesPref(apptEvt, pref))) {
      // Locked preference (title/chat states a specific day/time/date) — TOP priority.
      action = 'honor_pref';
      reason = 'Honoring stated preference '+JSON.stringify(pref);
    } else if (chatAction?.action === 'shorten') {
      // Agent left duration note — update if current duration is longer
      if (apptEvt) {
        const currentDur = (new Date(apptEvt.dtend) - new Date(apptEvt.dtstart)) / 3600000;
        if (currentDur > chatAction.durationHrs + 0.1) {
          action = 'shorten';
          reason = chatAction.note + ' (from '+chatAction.sender+')';
        }
      } else if (!apptEvt) {
        // No appointment yet — shorten hint gives us the duration, schedule it
        action = 'schedule_new';
        reason = 'Unscheduled + duration hint from '+chatAction.sender+': '+chatAction.durationHrs+'h';
      }
    } else if (chatAction?.action === 'reschedule' || chatAction?.action === 'accommodate_resident') {
      // Act on chat request whether meld is scheduled or not
      action = chatAction.action;
      reason = chatAction.note + ' (from '+chatAction.sender+' on '+chatAction.msgDate+')';
      if (apptEvt) log('  Chat request on already-scheduled meld — will reschedule: '+ref);
    } else if (isPastDue) {
      action = 'reschedule_pastdue';
      reason = 'Past due: was '+apptEvt.dtend.slice(0,10);
    } else if (apptEvt && isBlockedDay(apptDate) && !pref) {
      action = 'reschedule_blockedday';
      reason = 'On reserved day (Mon/weekend), relocating off '+apptDate;
    } else if (apptEvt && overlapIds.has(m.id) && !pref) {
      action = 'reschedule_overlap';
      reason = 'Double-booked on '+apptDate+', relocating to a free slot';
    } else if (isUnscheduled) {
      action = 'schedule_new';
      reason = 'Unscheduled';
    }

    if (!action) continue;

    log(ref+' ['+priority+'] '+brief.slice(0,40)+' → '+action+': '+reason);

    // Determine new slot
    let newSlot = null;
    // Use chat "shorten" hint only if it's a sane single-visit duration (0.25–4h);
    // otherwise fall back to the description estimate. Guards against parsing e.g.
    // "within 48 hours" as a 48-hour job. Hard cap at 8h (one workday) regardless.
    const shortenOk = chatAction?.action === 'shorten' && chatAction.durationHrs >= 0.25 && chatAction.durationHrs <= 4;
    const durHrs = Math.min(8, shortenOk ? chatAction.durationHrs : estimateDuration(brief));

    // Exclude this meld's OWN current appointment from the slot search, so it isn't blocked
    // by itself — otherwise a "move earlier" reschedule pushes it to the next free slot (LATER).
    let searchBusy = busyBlocks;
    if (apptEvt) {
      const os = pdtHr(apptEvt.dtstart), oe = pdtHr(apptEvt.dtend);
      searchBusy = {...busyBlocks, [apptDate]: (busyBlocks[apptDate]||[]).filter(b => Math.abs(b.start-os) > 0.01 || Math.abs(b.end-oe) > 0.01)};
    }

    // Locked preference takes priority over everything: place at the stated day/time.
    if (action === 'honor_pref' && pref) {
      newSlot = preferredSlot(pref, durHrs, searchBusy, today);
      if (newSlot) log('  → preferred slot '+newSlot.date+' '+String(newSlot.startHr).padStart(2,'0')+':'+String(newSlot.startMin).padStart(2,'0'));
    }

    if (!newSlot && chatAction?.action === 'accommodate_resident' && (chatAction.requestedDay || chatAction.requestedTime)) {
      // Try to honor resident preference
      const prefDay = chatAction.requestedDay ? nextOccurrenceOfDay(chatAction.requestedDay, today) : null;
      const prefTime = parseTime(chatAction.requestedTime);
      if (prefDay && prefTime) {
        const slotStart = prefTime.hr + prefTime.min/60;
        const slotEnd = slotStart + durHrs;
        const busy = searchBusy[prefDay] || [];
        const conflicts = busy.some(b => slotStart < b.end + 0.5 && slotEnd + 0.5 > b.start);
        if (!conflicts && slotEnd <= 17 && prefDay > today) {
          newSlot = {date: prefDay, startHr: prefTime.hr, startMin: prefTime.min, durationHrs: durHrs};
          log('  Honoring resident preference: '+prefDay+' '+prefTime.hr+':'+String(prefTime.min).padStart(2,'0'));
        }
      }
    }

    if (!newSlot && chatAction?.action === 'reschedule' && chatAction.requestedDay) {
      const prefDay = nextOccurrenceOfDay(chatAction.requestedDay, today);
      if (prefDay) {
        const openSlot = findNextSlot(searchBusy, durHrs, prefDay);
        if (openSlot?.date === prefDay) newSlot = openSlot;
      }
    }

    if (!newSlot) {
      // Litter pickup: always schedule first thing (force 8am slot)
      const isLitter = /litter pick/i.test(brief);
      const startSearch = action === 'shorten' ? (apptEvt?.dtstart?.slice(0,10) || today) : today;
      if (isLitter) {
        // Find next available date where 8am is free
        let d = new Date(startSearch+'T12:00:00-07:00');
        for (let i = 0; i < 21; i++) {
          d.setDate(d.getDate()+1);
          const ds = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
          if (d.getDay() === 0 || d.getDay() === 1 || d.getDay() === 6 || ds <= today) continue; // skip Mon + weekends
          const busy = (searchBusy[ds] || []);
          const slotEnd = 8 + durHrs;
          if (!busy.some(b => 8 < b.end + 0.25 && slotEnd + 0.25 > b.start)) {
            newSlot = {date: ds, startHr: 8, startMin: 0, durationHrs: durHrs};
            break;
          }
        }
      } else {
        newSlot = findNextSlot(searchBusy, durHrs, startSearch);
      }
    }

    if (!newSlot) {
      log('  Could not find slot for '+ref);
      continue;
    }

    // Idempotency: if the best achievable slot is exactly where it already sits, do nothing
    // (prevents churn when a chat request can't improve on the current placement).
    if (apptEvt && action !== 'shorten' && apptDate === newSlot.date && Math.abs(pdtHr(apptEvt.dtstart) - (newSlot.startHr + newSlot.startMin/60)) < 0.01) {
      log('  (already optimally placed — no change)');
      continue;
    }

    const {date, startHr, startMin, durationHrs: dh} = newSlot;
    const {dtstart, dtend} = slot(date, startHr, startMin, dh);

    // Apply the change
    let result;
    if (action === 'shorten' && apptEvt) {
      // Keep same date, just trim end time
      const sameDay = apptEvt.dtstart.slice(0,10);
      const t = parseTime(apptEvt.dtstart.slice(11,16));
      const shortSlot = slot(sameDay, t ? t.hr : startHr, t ? t.min : startMin, dh);
      result = await apiPatch('/api/melds/'+m.id+'/segments/reschedule/', sc, csrf, {
        mark_scheduled: true, segments_to_keep: [],
        new_segments: [{ event: { dtstart: shortSlot.dtstart, dtend: shortSlot.dtend } }]
      });
    } else if (m.started || apptEvt) {
      // Already started OR already has a real appointment → reschedule the existing one
      // (PENDING_COMPLETION melds require segments/reschedule/, not accept/)
      result = await apiPatch('/api/melds/'+m.id+'/segments/reschedule/', sc, csrf, {
        mark_scheduled: true, segments_to_keep: [],
        new_segments: [{ event: { dtstart, dtend } }]
      });
    } else {
      // Cancel any phantom appointments (have id but no availability_segment/event)
      // before calling accept, otherwise accept may be rejected
      for (const a of (m.managementappointment||[])) {
        if (!a.availability_segment || !a.availability_segment.event) {
          await apiPatch('/api/management-appointments/'+a.id+'/cancel/', sc, csrf, {});
          log('  Cleared phantom appointment '+a.id+' on '+ref);
        }
      }
      result = await apiPatch('/api/melds/'+m.id+'/accept/', sc, csrf, {
        mark_scheduled: true, segments_to_keep: [],
        management_availability_segments: [{ event: { dtstart, dtend } }]
      });
      if (result.status === 400 && result.body.includes('already been started')) {
        result = await apiPatch('/api/melds/'+m.id+'/segments/reschedule/', sc, csrf, {
          mark_scheduled: true, segments_to_keep: [],
          new_segments: [{ event: { dtstart, dtend } }]
        });
      }
    }

    if (result.status >= 200 && result.status < 300) {
      log('  ✓ Scheduled '+ref+' for '+date+' '+String(startHr).padStart(2,'0')+':'+String(startMin).padStart(2,'0')+' ('+dh+'h)');
      // Free the slot this meld vacated (if any) so nearer days can still be packed
      // by melds processed later in this run.
      if (apptEvt) {
        const od = apptEvt.dtstart.slice(0,10);
        if (busyBlocks[od]) {
          const os = pdtHr(apptEvt.dtstart), oe = pdtHr(apptEvt.dtend);
          busyBlocks[od] = busyBlocks[od].filter(b => Math.abs(b.start-os) > 0.01 || Math.abs(b.end-oe) > 0.01);
        }
      }
      // Reserve the new slot
      if (!busyBlocks[date]) busyBlocks[date] = [];
      busyBlocks[date].push({start: startHr+startMin/60, end: startHr+startMin/60+dh});
    } else {
      log('  ✗ Failed to schedule '+ref+': '+result.status+' '+result.body.slice(0,80));
    }
  }

  // ── PHASE 2: COMPACTION ──────────────────────────────────────────────────
  // Pull already-scheduled repairs into the nearest open slots so closer days are
  // always filled before later ones. Idempotent: once compacted, nothing moves.
  log('Compaction pass...');
  let fresh = [];
  for (const s of statuses) {
    let offset = 0;
    while (true) {
      const r = await apiGet('/api/melds/?limit=200&offset='+offset+'&status='+s, sc, csrf);
      const d = JSON.parse(r.body);
      fresh.push(...(d.results||[]).filter(m => m.in_house_servicers?.some(srv => srv.agent?.id === JONAS_ID)));
      if (!d.next || !d.results?.length) break;
      offset += 200;
    }
  }
  const fseen = new Set(); fresh = fresh.filter(m => { if (fseen.has(m.id)) return false; fseen.add(m.id); return true; });
  const apptOf = m => m.managementappointment?.find(a => a.availability_segment?.event)?.availability_segment?.event;
  // Movable = Jonas's tc68/tc34 non-turn repairs with a future appt on a non-reserved day
  const movable = fresh.filter(m => {
    const po = (m.unit && m.unit.prop) ? m.unit.prop : m.prop;
    const prop = (po?.property_name || '').toLowerCase();
    if (!(prop.startsWith('tc68') || prop.startsWith('tc34')) || m.project) return false;
    const e = apptOf(m);
    return e && e.dtstart.slice(0,10) > today && !isBlockedDay(e.dtstart.slice(0,10));
  });
  const movableIds = new Set(movable.map(m => m.id));
  // Fixed calendar = everything else Jonas has (turns, etc.) — never moved
  const fixedBusy = buildBusyBlocks(fresh.filter(m => !movableIds.has(m.id)));
  // Process earliest-scheduled first so we never leapfrog an earlier meld
  movable.sort((a,b) => apptOf(a).dtstart.localeCompare(apptOf(b).dtstart));
  let pulled = 0;
  for (const m of movable) {
    const cur = apptOf(m);
    const curDate = cur.dtstart.slice(0,10);
    const curStart = pdtHr(cur.dtstart);
    const dur = Math.max(0.5, (new Date(cur.dtend) - new Date(cur.dtstart)) / 3600000);
    // Preference-locked melds (specific day/time from title or chat) are never pulled —
    // keep them exactly where Phase 1 honored the preference.
    if (lockedPrefs.has(m.id)) {
      (fixedBusy[curDate] = fixedBusy[curDate] || []).push({ start: curStart, end: pdtHr(cur.dtend) });
      continue;
    }
    const ns = findNextSlot(fixedBusy, dur, today);
    const earlier = ns && (ns.date < curDate || (ns.date === curDate && (ns.startHr + ns.startMin/60) < curStart - 0.01));
    if (earlier) {
      const { dtstart, dtend } = slot(ns.date, ns.startHr, ns.startMin, dur);
      const r = await apiPatch('/api/melds/'+m.id+'/segments/reschedule/', sc, csrf, {
        mark_scheduled: true, segments_to_keep: [], new_segments: [{ event: { dtstart, dtend } }]
      });
      if (r.status >= 200 && r.status < 300) {
        log('  ⇐ Pulled '+m.reference_id+' '+curDate+' → '+ns.date+' '+String(ns.startHr).padStart(2,'0')+':'+String(ns.startMin).padStart(2,'0'));
        (fixedBusy[ns.date] = fixedBusy[ns.date] || []).push({ start: ns.startHr + ns.startMin/60, end: ns.startHr + ns.startMin/60 + dur });
        pulled++;
      } else {
        log('  ✗ Compact failed '+m.reference_id+': '+r.status);
        (fixedBusy[curDate] = fixedBusy[curDate] || []).push({ start: curStart, end: pdtHr(cur.dtend) });
      }
    } else {
      // Keep where it is; reserve its slot
      (fixedBusy[curDate] = fixedBusy[curDate] || []).push({ start: curStart, end: pdtHr(cur.dtend) });
    }
  }
  log('Compaction: '+pulled+' meld(s) pulled earlier');

  // 3. Save log (only if LOG_FILE is set)
  if (LOG_FILE) {
    let existingLog = [];
    try { existingLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {}
    existingLog.push({runAt, actions});
    if (existingLog.length > 100) existingLog = existingLog.slice(-100);
    fs.writeFileSync(LOG_FILE, JSON.stringify(existingLog, null, 2));
  }

  log('=== Done ===');
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
