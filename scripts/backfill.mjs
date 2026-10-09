import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { accumulator, addQuote, fetchBytes, finish, mergeDays, officialUrl, readJson, regenerateSummary, utcDay } from './archive.mjs';

const root = resolve(process.env.ARCHIVE_ROOT ?? '.');
// The Git tree includes old raw paths even in a sparse checkout.
const rawDays = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', 'raw/'], { cwd: root, encoding: 'utf8' })
  .split('\n').map((path) => /^raw\/(\d{4}-\d{2}-\d{2})\/\d{2}\.json\.gz$/.exec(path)?.[1]).filter(Boolean).sort();
if (!rawDays.length) throw new Error('Collect and commit an official raw snapshot before backfilling.');
const cutoff = rawDays[0];
const snapshot = JSON.parse(await fetchBytes(officialUrl));
const hrids = Object.keys(snapshot.marketData).sort();
const replacements = {};
let rowsSeen = 0;
let rowsAccepted = 0;
let itemsWithHistory = 0;
for (let offset = 0; offset < hrids.length; offset += 10) {
  if (offset) await sleep(1500);
  const batch = hrids.slice(offset, offset + 10);
  const url = new URL('https://q7.nainai.eu.org/api/market/histories');
  for (const hrid of batch) url.searchParams.append('item_id', hrid);
  url.searchParams.set('variant', '0');
  url.searchParams.set('days', '365');
  const response = JSON.parse(await fetchBytes(url));
  for (const hrid of batch) {
    const rows = response[hrid]?.['0'];
    if (!Array.isArray(rows)) throw new Error(`Invalid history response for ${hrid}`);
    rowsSeen += rows.length;
    const seen = new Set();
    let accepted = 0;
    const byDay = {};
    for (const row of rows) {
      if (!Number.isFinite(row.time)) throw new Error(`Invalid history time for ${hrid}`);
      const day = utcDay(row.time);
      if (day >= cutoff || seen.has(row.time)) continue;
      seen.add(row.time);
      addQuote(byDay[day] ??= accumulator(), row);
      accepted++;
    }
    if (accepted) itemsWithHistory++;
    rowsAccepted += accepted;
    for (const [day, state] of Object.entries(byDay)) {
      ((replacements[day] ??= {})[hrid] ??= {})['0'] = finish(state);
    }
  }
  console.log(`Fetched ${Math.min(offset + batch.length, hrids.length)}/${hrids.length} items; ${rowsAccepted} eligible hourly rows`);
}
await mergeDays(root, replacements);
const summary = await readJson(`${root}/summary.json`);
await regenerateSummary(root, summary.timestamp);
const days = Object.keys(replacements).sort();
console.log(JSON.stringify({ source: 'q7 (one-time only)', cutoff, itemsRequested: hrids.length, itemsWithHistory, rowsSeen,
  rowsAccepted, days: days.length, firstDay: days[0], lastDay: days.at(-1), months: new Set(days.map((day) => day.slice(0, 7))).size }));
