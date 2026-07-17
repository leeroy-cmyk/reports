#!/usr/bin/env node
/**
 * extract-rules.js — builds data/scheduling_rules.json for the public
 * "Scheduling Rules" report by reading the shared rulebook
 * (leeroy-cmyk/pm-scheduling → CLAUDE.md, the "## Scheduling rules" section).
 *
 * Cloud: set PM_SCHEDULING_TOKEN (a fine-grained PAT with Contents:read on
 *   pm-scheduling) and it fetches CLAUDE.md via the GitHub API.
 * Local: set RULES_LOCAL_FILE=/path/to/pm-scheduling/CLAUDE.md to parse a file.
 *
 * If the source can't be fetched, the previous scheduling_rules.json is kept
 * (only its last_checked timestamp is bumped) so the page never goes blank.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const REPO = 'leeroy-cmyk/pm-scheduling';
const FILE = 'CLAUDE.md';
const OUT  = path.join(__dirname, '..', 'data', 'scheduling_rules.json');

function fetchRemote() {
  return new Promise((resolve, reject) => {
    const token = process.env.PM_SCHEDULING_TOKEN;
    if (!token) return reject(new Error('PM_SCHEDULING_TOKEN not set'));
    const req = https.get({
      hostname: 'api.github.com',
      path: `/repos/${REPO}/contents/${FILE}`,
      headers: {
        'User-Agent': 'reports-rules-extractor',
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github.raw+json',
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => res.statusCode === 200
        ? resolve(d)
        : reject(new Error('GitHub API ' + res.statusCode + ': ' + d.slice(0, 200))));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('GitHub API timeout')));
  });
}

function getMarkdown() {
  if (process.env.RULES_LOCAL_FILE) return Promise.resolve(fs.readFileSync(process.env.RULES_LOCAL_FILE, 'utf8'));
  return fetchRemote();
}

function parseRules(md) {
  const lines = md.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Scheduling rules/i.test(lines[i])) { start = i + 1; break; }
  }
  if (start < 0) return [];
  const rules = [];
  let group = 'General';                 // current ### subsection
  let cur = null;
  const push = () => { if (cur) { rules.push(cur); cur = null; } };
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;                          // next ## section ends the rulebook
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) { push(); group = h3[1].replace(/\s+[—–-]\s.*$/, '').replace(/\s*\(.*$/, '').trim() || h3[1].trim(); continue; }  // "Tacoma — tc68" -> "Tacoma"; keeps internal hyphens ("Tri-Cities Grounds/Lawn"); strips "(Rey + Hannah)"
    const top = line.match(/^-\s+(.*)$/);
    const sub = line.match(/^\s+-\s+(.*)$/);
    if (top) {
      push();
      const full = top[1].trim();
      let txt = full;
      let category = '';
      const b = full.match(/^\*\*(.+?)\*\*(.*)$/);          // leading **bold** + remainder
      if (b) {
        const inner = b[1].trim();
        const after = b[2];
        if (/[:：]\s*$/.test(inner)) {                      // "**Label:** rest" — clear label
          category = inner.replace(/[:：]\s*$/, '').trim();
          txt = after.trim();
        } else if (after.trim() === '') {                  // whole bullet is bold
          const m = inner.match(/^(.+?)\s+—\s+(.+)$/);      // "**Label — rule.**"
          if (m) { category = m[1].trim(); txt = m[2].trim(); } else { txt = inner; }
        }
        // else: mid-sentence emphasis → keep full bullet, render bold inline (category stays '')
      }
      cur = { group, category, text: txt, details: [] };
    } else if (sub && cur) {
      cur.details.push(sub[1].trim());
    } else if (cur && line.trim()) {
      cur.text += (cur.text ? ' ' : '') + line.trim();             // wrapped continuation line
    }
  }
  push();
  return rules;
}

(async () => {
  let md, err = null;
  try { md = await getMarkdown(); } catch (e) { err = e.message; }

  if (err) {
    if (fs.existsSync(OUT)) {
      const cur = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      cur.last_checked = new Date().toISOString();
      cur.note = 'Could not refresh from source (' + err + ') — showing last known rules.';
      fs.writeFileSync(OUT, JSON.stringify(cur, null, 2));
      console.log('extract-rules: source unavailable, kept existing rules. ' + err);
      return;
    }
    throw new Error('No rules source and no existing file: ' + err);
  }

  const rules = parseRules(md);
  const now = new Date().toISOString();

  // Only rewrite when the rules actually changed — keeps generated_at meaningful
  // (= last real change) and avoids a no-op commit on every daily run.
  let prev = null;
  if (fs.existsSync(OUT)) { try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {} }
  if (prev && JSON.stringify(prev.rules) === JSON.stringify(rules)) {
    console.log('scheduling_rules.json: ' + rules.length + ' rules, unchanged (no write)');
    return;
  }
  fs.writeFileSync(OUT, JSON.stringify({
    generated_at: now,
    last_checked: now,
    source: REPO + '/' + FILE,
    count: rules.length,
    rules,
  }, null, 2));
  console.log('scheduling_rules.json: ' + rules.length + ' rules (updated)');
})();
