import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fetchBytes, officialUrl, rebuildDays, utcDay } from './archive.mjs';

// Default: fetch the official snapshot, store it as raw/<day>/<hour>.json.gz and rebuild that day.
// --aggregate: fetch nothing; rebuild the two newest raw days from raw files pushed by another collector
// (the inherit monitor uploads each hourly snapshot as soon as it is published).
// --sparse: widen the sparse checkout to the raw days needed.
const root = resolve(process.env.ARCHIVE_ROOT ?? '.');
const sparse = process.argv.includes('--sparse');
const checkout = (days) => {
  if (sparse) execFileSync('git', ['sparse-checkout', 'set', 'scripts', 'daily', ...days.map((day) => `raw/${day}`)], { cwd: root, stdio: 'inherit' });
};

if (process.argv.includes('--aggregate')) {
  // The two newest days, so a run that replaced a cancelled pending one still covers the previous UTC day.
  const days = execFileSync('git', ['ls-tree', '-d', '--name-only', 'HEAD', 'raw/'], { cwd: root, encoding: 'utf8' })
    .split('\n').map((path) => path.replace(/^raw\//, '')).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort().slice(-2);
  checkout(days);
  const result = await rebuildDays(root, days);
  console.log(result ? `Rebuilt ${result.days.join(', ')}; summary ${JSON.stringify(result.summary)}` : 'No raw snapshots to rebuild.');
} else {
  const bytes = await fetchBytes(officialUrl);
  const snapshot = JSON.parse(bytes);
  if (!Number.isInteger(snapshot.timestamp) || !snapshot.marketData || !Object.keys(snapshot.marketData).length) {
    throw new Error('Invalid official snapshot');
  }
  const day = utcDay(snapshot.timestamp);
  const hour = new Date(snapshot.timestamp * 1000).toISOString().slice(11, 13);
  checkout([day]);
  await mkdir(join(root, 'raw', day), { recursive: true });
  try {
    await writeFile(join(root, 'raw', day, `${hour}.json.gz`), gzipSync(bytes), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log(`Already archived ${day}/${hour}; no changes.`);
    process.exit(0);
  }
  const result = await rebuildDays(root, [day]);
  console.log(`Archived ${day}/${hour}: ${bytes.length} bytes; summary ${JSON.stringify(result.summary)}`);
}
