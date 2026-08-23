#!/usr/bin/env node
/*
 * set-password.js — set the reports-site password.
 *
 *   node set-password.js "my new password"
 *
 * Generates a fresh random salt, derives a PBKDF2-SHA256 hash, and writes both
 * into auth.js. The plaintext password is never stored anywhere. Changing the
 * password also invalidates every "keep me signed in" session automatically,
 * because the stored token is compared against the new hash.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ITERATIONS = 200000;
const AUTH_FILE = path.join(__dirname, 'auth.js');

const password = process.argv.slice(2).join(' ');
if (!password) {
  console.error('Usage: node set-password.js "your new password"');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Refusing: use at least 8 characters.');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto
  .pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256')
  .toString('hex');

let src = fs.readFileSync(AUTH_FILE, 'utf8');
const before = src;

src = src.replace(/(salt:\s*')[^']*(')/, `$1${salt.toString('hex')}$2`);
src = src.replace(/(hash:\s*')[^']*(')/, `$1${hash}$2`);
src = src.replace(/(iterations:\s*)\d+/, `$1${ITERATIONS}`);

if (src === before) {
  console.error('Could not find the CONFIG block in auth.js — aborting.');
  process.exit(1);
}

fs.writeFileSync(AUTH_FILE, src);
console.log('Password updated in auth.js.');
console.log('All existing signed-in sessions are now invalidated.');
console.log('\nCommit and push to apply it to the live site:');
console.log('  git add auth.js && git commit -m "chore: rotate reports password" && git push');
