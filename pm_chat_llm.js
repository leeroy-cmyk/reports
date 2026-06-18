/**
 * LLM chat reader for the PropertyMeld schedulers.
 * Reads a meld's chat like a human coordinator and returns a STRUCTURED scheduling
 * intent. The scheduler then applies it deterministically (Mon/weekend, no-overlap,
 * fill-nearest, preference-lock rules stay enforced in code — the model never writes
 * the calendar directly).
 *
 * Requires ANTHROPIC_API_KEY. If absent or any call fails, analyzeChat() returns null
 * and the caller falls back to its keyword parser — so the scheduler never breaks.
 *
 * Model via PM_LLM_MODEL (default claude-sonnet-4-6). Uses raw HTTPS (the schedulers
 * have no SDK dependency) + structured outputs so the JSON is schema-validated.
 */
const https = require('https');
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.PM_LLM_MODEL || 'claude-sonnet-4-6';

function llmEnabled() { return !!KEY; }

const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    has_request:       { type: 'boolean', description: 'true if a resident or tech is asking to schedule/reschedule/avoid a time. false for chit-chat, status updates, thanks, etc.' },
    already_satisfied: { type: 'boolean', description: 'true if the CURRENT appointment shown already satisfies the latest request (so no change is needed).' },
    intent:            { type: 'string', enum: ['reschedule_earlier', 'reschedule_specific', 'accommodate_preference', 'cancel_or_hold', 'none'] },
    preferred_date:    { type: 'string', description: 'A specific calendar date the work should happen, as YYYY-MM-DD. Empty string if none. Resolve relative dates (e.g. "next Tuesday") against today.' },
    preferred_day:     { type: 'string', enum: ['', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'], description: 'Preferred day of week, or empty.' },
    preferred_time:    { type: 'string', description: "Preferred start time like '2:00 pm' or '9:30 am'. Empty string if none." },
    avoid_days:        { type: 'array', items: { type: 'string', enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] }, description: 'Days the resident said they are NOT available.' },
    duration_hours:    { type: 'number', description: 'Hint at how long the job needs if stated, else 0.' },
    requested_by:      { type: 'string', enum: ['tenant', 'agent', 'unknown'] },
    reasoning:         { type: 'string', description: 'One sentence: what the latest relevant message asked for.' },
  },
  required: ['has_request', 'already_satisfied', 'intent', 'preferred_date', 'preferred_day', 'preferred_time', 'avoid_days', 'duration_hours', 'requested_by', 'reasoning'],
};

const SYSTEM =
`You are a maintenance scheduling coordinator for a property-management company.
You read the chat thread on a work order (messages between residents/tenants, the maintenance tech, and managers) and decide whether there is an actionable scheduling request that is NOT already reflected in the current appointment.

Rules and context:
- Work is scheduled Tuesday–Friday only. Mondays and weekends are reserved (do not propose them unless the resident explicitly insists on a specific weekend/Monday date).
- "earlier than X" / "before X" / "sooner" / "can you come sooner" means the resident wants the SOONEST available slot — that is intent "reschedule_earlier" with X recorded in avoid_days only if it is a day-of-week. Never treat the day they want to avoid as the target.
- A specific date/day/time the resident or tech asks for is intent "reschedule_specific" (date) or "accommodate_preference" (day/time only).
- If the resident is just confirming, thanking, giving access notes, or describing the problem, has_request = false.
- If the current appointment already matches what was asked, set already_satisfied = true.
- Only act on the most recent relevant request; ignore older superseded ones.
- Resolve relative dates against the provided "Today" date. Output dates as YYYY-MM-DD.
Return only the structured object.`;

function buildUserContent(brief, messages, currentApptISO, today) {
  const lines = [];
  lines.push(`Today: ${today}`);
  lines.push(`Work order: ${brief || '(no title)'}`);
  lines.push(`Current appointment: ${currentApptISO ? currentApptISO : 'NONE (unscheduled)'}`);
  lines.push('');
  lines.push('Chat (oldest to newest):');
  const recent = (messages || []).slice(-25);
  if (!recent.length) lines.push('(no messages)');
  for (const m of recent) {
    const who = m.tenant ? `TENANT ${((m.tenant.first_name||'')+' '+(m.tenant.last_name||'')).trim()}`
              : m.agent  ? `STAFF ${((m.agent.user&&m.agent.user.first_name||'')+' '+(m.agent.user&&m.agent.user.last_name||'')).trim()}`
              : (m.commenter_name || 'unknown');
    const when = (m.created || '').slice(0, 10);
    const text = (m.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (text) lines.push(`[${when}] ${who}: ${text}`);
  }
  return lines.join('\n').slice(0, 8000);
}

function apiCall(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{ resolve({status:res.statusCode, json:JSON.parse(d)}); }catch(e){ reject(new Error('parse '+res.statusCode+': '+d.slice(0,200))); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}

// Returns { intent, pref:{dayName,time,dateStr}|null, earlier:bool, avoidDays:[], durationHrs:num|null, reasoning } or null.
async function analyzeChat(brief, messages, currentApptISO, today) {
  if (!KEY) return null;
  try {
    const r = await apiCall({
      model: MODEL,
      max_tokens: 700,
      thinking: { type: 'disabled' },
      system: SYSTEM,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: buildUserContent(brief, messages, currentApptISO, today) }],
    });
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.content)) return null;
    if (r.json.stop_reason === 'refusal') return null;
    const textBlock = r.json.content.find(b => b.type === 'text');
    if (!textBlock) return null;
    const out = JSON.parse(textBlock.text);
    if (!out.has_request || out.already_satisfied || out.intent === 'none' || out.intent === 'cancel_or_hold') {
      return { intent: 'none', pref: null, earlier: false, avoidDays: out.avoid_days || [], durationHrs: out.duration_hours || null, reasoning: out.reasoning || '' };
    }
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(out.preferred_date) ? out.preferred_date : null;
    const dayName = out.preferred_day || null;
    const time = out.preferred_time && /\d/.test(out.preferred_time) ? out.preferred_time : null;
    const pref = (dateStr || dayName || time) ? { dayName, time, dateStr } : null;
    return {
      intent: out.intent,
      pref,
      earlier: out.intent === 'reschedule_earlier',
      avoidDays: out.avoid_days || [],
      durationHrs: out.duration_hours > 0 ? out.duration_hours : null,
      reasoning: out.reasoning || '',
    };
  } catch (e) {
    return null; // any failure → caller falls back to keyword parser
  }
}

module.exports = { analyzeChat, llmEnabled, MODEL };
