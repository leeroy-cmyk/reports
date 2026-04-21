// Local dev server — serves static files + POST /api/refresh to pull fresh data
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3005;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

let refreshRunning = false;

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // POST /api/refresh — runs fetch-data.js (QBT + audit) in the background
  if (req.method === 'POST' && req.url === '/api/refresh') {
    if (refreshRunning) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: 'Refresh already in progress' }));
      return;
    }
    refreshRunning = true;
    console.log('[refresh] Starting QBT + audit fetch...');

    const env = { ...process.env, FETCH_ONLY: 'qbt-ramp' };
    const child = spawn('node', [path.join(ROOT, 'scripts/fetch-data.js')], { env, cwd: ROOT });

    child.stdout.on('data', d => process.stdout.write('[fetch] ' + d));
    child.stderr.on('data', d => process.stderr.write('[fetch:err] ' + d));

    child.on('close', code => {
      refreshRunning = false;
      console.log('[refresh] Done, exit code ' + code);
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Refresh started' }));
    return;
  }

  // GET /api/refresh-status
  if (req.method === 'GET' && req.url === '/api/refresh-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ running: refreshRunning }));
    return;
  }

  // Static file serving
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ct = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });

}).listen(PORT, () => console.log('Reports server running at http://localhost:' + PORT));
