import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const turnQueueDirectory = (db) => path.join(path.dirname(db), 'turn-outbox');
function regular(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (!directory && (!stat.isFile() || stat.nlink !== 1))
    || (directory && (!stat.isDirectory() || fs.realpathSync.native(file) !== file))) throw new Error('unsafe turn journal path');
}
function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function journalTurn(step, db, key) {
  const dir = turnQueueDirectory(db);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); regular(dir, true);
  const file = path.join(dir, `${digest(key)}.json`);
  const value = step.args[step.args.indexOf('--value') + 1];
  const record = { schemaVersion: 1, key, contentDigest: digest(value), consentScope: 'canonical-project-and-path', step };
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(dir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = readJournal(file, db);
    if (previous.key !== key || previous.contentDigest !== record.contentDigest) throw new Error('turn journal identity collision');
  }
  return file;
}
export function readJournal(file, db) {
  const dir = turnQueueDirectory(db); regular(dir, true);
  if (path.dirname(file) !== dir) throw new Error('foreign turn journal rejected');
  regular(file);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const step = record.step;
  if (record.schemaVersion !== 1 || record.consentScope !== 'canonical-project-and-path' || step?.kind !== 'store'
    || !Array.isArray(step.args) || step.args.includes('--upsert') || step.args.includes('-u') || !step.args.includes('--no-upsert')
    || step.args[step.args.indexOf('--path') + 1] !== db
    || step.args[step.args.indexOf('-k') + 1] !== record.key
    || digest(step.args[step.args.indexOf('--value') + 1]) !== record.contentDigest
    || path.basename(file) !== `${digest(record.key)}.json`) throw new Error('invalid turn journal');
  return record;
}
export function pendingTurnFiles(db, limit = 10) {
  const dir = turnQueueDirectory(db);
  try { regular(dir, true); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return fs.readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort().slice(0, Math.min(25, Math.max(0, limit))).map((name) => path.join(dir, name));
}
export function acknowledgeJournal(file, db) {
  readJournal(file, db); fs.unlinkSync(file); syncDirectory(path.dirname(file));
}
export function appendReceipt(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) regular(file);
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(row)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
