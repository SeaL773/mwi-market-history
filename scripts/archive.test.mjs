import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { aggregateSnapshots, mergeDays, readJson, rebuildDays, regenerateSummary } from './archive.mjs';

const snapshot = (marketData) => ({ marketData });

test('daily aggregation ignores empty book sides and weights trades by volume', () => {
  const result = aggregateSnapshots([
    snapshot({ '/items/test': { 0: { a: -1, b: 8, p: 10, v: 1 }, 2: { a: -1, b: -1 } } }),
    snapshot({ '/items/test': { 0: { a: 12, b: -1, p: 20, v: 3 } } }),
    snapshot({ '/items/test': { 0: { a: 16, b: 10 } } }),
  ]);
  assert.deepEqual(result['/items/test'][0], { tuple: [14, 9, 18, 4], trades: [70, 4] });
  assert.deepEqual(result['/items/test'][2], { tuple: [null, null, null, 0], trades: [0, 0] });
});

test('summary selects seven data days across months, preserves exact VWAP, and aligns missing rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mwi-archive-test-'));
  try {
    const days = ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-02', '2026-10-03', '2026-10-04'];
    const replacements = {};
    for (const [index, day] of days.entries()) {
      replacements[day] = aggregateSnapshots([snapshot({ '/items/test': { 0: { a: index + 10, b: -1, p: index === 0 ? 999 : 10.49, v: 1 } } })]);
    }
    replacements[days.at(-1)]['/items/test'][0] = { tuple: [20, null, 11, 1], trades: [10.6, 1] };
    replacements[days.at(-1)]['/items/new'] = { 0: { tuple: [5, null, null, 0], trades: [0, 0] },
      2: { tuple: [50, 40, 45, 14], trades: [630, 14] } };
    await mergeDays(root, replacements);
    await regenerateSummary(root, Date.parse('2026-10-04T01:06:00Z') / 1000);
    const summary = await readJson(join(root, 'summary.json'));
    assert.deepEqual(summary.items['/items/test'][0], [11, 1, 14, null]);
    assert.deepEqual(summary.items['/items/new'][0], [null, 0, 5, null]);
    assert.deepEqual(summary.items['/items/new'][2], [45, 2, 50, 40]);
    const zero = await readJson(join(root, 'daily/2026-10/0.json'));
    assert.deepEqual(zero.days, ['2026-10-02', '2026-10-03', '2026-10-04']);
    assert.deepEqual(zero.items['/items/new'], [null, null, [5, null, null, 0]]);
    await mergeDays(root, { '2026-10-02': aggregateSnapshots([snapshot({ '/items/replacement': { 0: { a: 4, b: 2 } } })]) });
    const updated = await readJson(join(root, 'daily/2026-10/0.json'));
    assert.deepEqual(updated.items['/items/test'], [null, zero.items['/items/test'][1], zero.items['/items/test'][2]]);
    assert.deepEqual(updated.items['/items/replacement'], [[4, 2, null, 0], null, null]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rebuildDays aggregates pushed raw snapshots per day and dates the summary by the newest one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mwi-archive-test-'));
  try {
    const raw = async (day, hour, quote) => {
      await mkdir(join(root, 'raw', day), { recursive: true });
      const timestamp = Date.parse(`${day}T${hour}:06:00Z`) / 1000;
      await writeFile(join(root, 'raw', day, `${hour}.json.gz`), gzipSync(JSON.stringify({ timestamp, marketData: { '/items/test': { 0: quote } } })));
      return timestamp;
    };
    await raw('2026-10-12', '23', { a: 10, b: 8 });
    await raw('2026-10-13', '00', { a: 20, b: -1, p: 15, v: 2 });
    const newest = await raw('2026-10-13', '01', { a: 30, b: 12 });
    const result = await rebuildDays(root, ['2026-10-12', '2026-10-13', '2026-10-14']);
    assert.deepEqual(result.days, ['2026-10-12', '2026-10-13'], 'days without raw files are skipped');
    const zero = await readJson(join(root, 'daily/2026-10/0.json'));
    assert.deepEqual(zero.days, ['2026-10-12', '2026-10-13']);
    assert.deepEqual(zero.items['/items/test'], [[10, 8, null, 0], [25, 12, 15, 2]]);
    assert.equal((await readJson(join(root, 'summary.json'))).timestamp, newest);
    await writeFile(join(root, 'raw', '2026-10-13', '02.json.gz'), gzipSync(JSON.stringify({ timestamp: newest - 86400, marketData: {} })));
    await assert.rejects(rebuildDays(root, ['2026-10-13']), /Snapshot day mismatch/, 'a snapshot filed under the wrong day is refused');
    assert.equal(await rebuildDays(root, ['2026-09-01']), null, 'nothing to rebuild');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
