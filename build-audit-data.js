// Preprocesses qbtime.json into a compact audit dataset for timecard_audit.html
const fs = require('fs');
const path = require('path');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/qbtime.json'), 'utf8'));
const { users, jobcodes, timesheets, fetched_at } = raw;

function getPath(id) {
  const j = jobcodes[id];
  if (!j) return [];
  if (j.parent_id === 0) return [j.name];
  return [...getPath(j.parent_id), j.name];
}

const entries = Object.values(timesheets)
  .filter(t => t.type === 'regular')
  .map(t => {
    const u = users[t.user_id];
    const name = u ? u.first_name + ' ' + u.last_name : 'User ' + t.user_id;
    const cls   = t.customfields['25056'] || '';
    const prop  = t.customfields['25068'] || '';
    const path  = getPath(t.jobcode_id);

    const isOpex = cls === 'r203';
    const hasSpecificProp = prop.trim() && prop !== 'r203';
    const issues = [];
    if (t.duration > 7200)                                      issues.push('long');
    if (!prop.trim() && !isOpex)                                issues.push('prop');
    if (hasSpecificProp && !cls.trim())                          issues.push('class');
    if (path.length < 3 && !isOpex)                            issues.push('cust');
    if (!t.notes || t.notes.trim().length < 3)                  issues.push('notes');

    return {
      id:    t.id,
      date:  t.date,
      name,
      dur:   t.duration,
      prop,
      cls,
      path,
      notes: t.notes || '',
      issues
    };
  });

const out = { fetched_at, entries };
fs.writeFileSync(path.join(__dirname, 'data/audit.json'), JSON.stringify(out));
console.log(`Written ${entries.length} entries (${(JSON.stringify(out).length/1024).toFixed(0)} KB)`);
