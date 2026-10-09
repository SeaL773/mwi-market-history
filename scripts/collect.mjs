import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { aggregateSnapshots, fetchBytes, mergeDays, officialUrl, regenerateSummary, utcDay } from './archive.mjs';

const root = resolve(process.env.ARCHIVE_ROOT ?? '.');
const bytes = await fetchBytes(officialUrl);
const snapshot = JSON.parse(bytes);
if (!Number.isInteger(snapshot.timestamp) || !snapshot.marketData || !Object.keys(snapshot.marketData).length) {
  throw new Error('Invalid official snapshot');
}
const day = utcDay(snapshot.timestamp);
const hour = new Date(snapshot.timestamp * 1000).toISOString().slice(11, 13);
const rawPath = `raw/${day}`;
if (process.argv.includes('--sparse')) {
  execFileSync('git', ['sparse-checkout', 'set', 'scripts', 'daily', rawPath], { cwd: root, stdio: 'inherit' });
}
await mkdir(join(root, rawPath), { recursive: true });
try {
  await writeFile(join(root, rawPath, `${hour}.json.gz`), gzipSync(bytes), { flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log(`Already archived ${day}/${hour}; no changes.`);
  process.exit(0);
}
const snapshots = [];
for (const file of (await readdir(join(root, rawPath))).filter((name) => /^\d{2}\.json\.gz$/.test(name)).sort()) {
  const value = JSON.parse(gunzipSync(await readFile(join(root, rawPath, file))));
  if (utcDay(value.timestamp) !== day) throw new Error(`Snapshot day mismatch: ${file}`);
  snapshots.push(value);
}
await mergeDays(root, { [day]: aggregateSnapshots(snapshots) });
const latest = Math.max(...snapshots.map((value) => value.timestamp));
const summary = await regenerateSummary(root, latest);
console.log(`Archived ${day}/${hour}: ${bytes.length} bytes; ${snapshots.length} hourly snapshots; summary ${JSON.stringify(summary)}`);
