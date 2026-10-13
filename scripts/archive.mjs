import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const officialUrl = 'https://www.milkywayidle.com/game_data/marketplace.json';
export const utcDay = (timestamp) => new Date(timestamp * 1000).toISOString().slice(0, 10);

export async function fetchBytes(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 3) throw error;
      console.warn(`Fetch retry ${attempt + 1}: ${error.message}`);
      await sleep(2000 * 2 ** attempt);
    }
  }
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

export async function directories(path) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function accumulator() {
  return { asks: [], bids: [], value: 0, volume: 0 };
}

export function addQuote(target, quote) {
  if (Number.isFinite(quote.a) && quote.a > 0) target.asks.push(quote.a);
  if (Number.isFinite(quote.b) && quote.b > 0) target.bids.push(quote.b);
  if (Number.isFinite(quote.v) && quote.v > 0 && Number.isFinite(quote.p) && quote.p > 0) {
    target.value += quote.p * quote.v;
    target.volume += quote.v;
  }
}

export function median(values) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return Math.round(values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2);
}

export function finish(target) {
  return {
    tuple: [median(target.asks), median(target.bids), target.volume ? Math.round(target.value / target.volume) : null, target.volume],
    trades: [target.value, target.volume],
  };
}

export function aggregateSnapshots(snapshots) {
  const items = {};
  for (const snapshot of snapshots) {
    for (const [hrid, levels] of Object.entries(snapshot.marketData)) {
      const item = items[hrid] ??= {};
      for (const [level, quote] of Object.entries(levels)) addQuote(item[level] ??= accumulator(), quote);
    }
  }
  for (const levels of Object.values(items)) {
    for (const [level, state] of Object.entries(levels)) levels[level] = finish(state);
  }
  return items;
}

// Merge whole days, preserving all other days and padding missing item/level rows.
export async function mergeDays(root, replacements) {
  const months = [...new Set(Object.keys(replacements).map((day) => day.slice(0, 7)))].sort();
  for (const month of months) {
    const path = join(root, 'daily', month);
    const empty = () => ({ days: [], items: {} });
    const zero = await readJson(join(path, '0.json'), empty());
    const enhanced = await readJson(join(path, 'enhanced.json'), empty());
    const trades = await readJson(join(path, 'trades.json'), empty());
    const dayItems = {};
    for (const [index, day] of zero.days.entries()) {
      const items = dayItems[day] ??= {};
      for (const [hrid, rows] of Object.entries(zero.items)) {
        if (rows[index] !== null) (items[hrid] ??= {})['0'] = { tuple: rows[index] };
      }
    }
    for (const [index, day] of enhanced.days.entries()) {
      const items = dayItems[day] ??= {};
      for (const [hrid, levels] of Object.entries(enhanced.items)) {
        for (const [level, rows] of Object.entries(levels)) {
          if (rows[index] !== null) (items[hrid] ??= {})[level] = { tuple: rows[index] };
        }
      }
    }
    for (const [index, day] of trades.days.entries()) {
      for (const [hrid, levels] of Object.entries(trades.items)) {
        for (const [level, rows] of Object.entries(levels)) {
          if (rows[index] !== null) dayItems[day][hrid][level].trades = rows[index];
        }
      }
    }
    for (const [day, items] of Object.entries(replacements)) {
      if (day.startsWith(month)) dayItems[day] = items;
    }
    const days = Object.keys(dayItems).sort();
    const outputs = { zero: { days, items: {} }, enhanced: { days, items: {} }, trades: { days, items: {} } };
    for (const [index, day] of days.entries()) {
      for (const [hrid, levels] of Object.entries(dayItems[day])) {
        for (const [level, result] of Object.entries(levels)) {
          if (!result.trades) throw new Error(`Missing exact trade totals: ${day} ${hrid} +${level}`);
          const publicItems = level === '0' ? outputs.zero.items : (outputs.enhanced.items[hrid] ??= {});
          const key = level === '0' ? hrid : level;
          (publicItems[key] ??= Array(days.length).fill(null))[index] = result.tuple;
          const exact = outputs.trades.items[hrid] ??= {};
          (exact[level] ??= Array(days.length).fill(null))[index] = result.trades;
        }
      }
    }
    await writeJson(join(path, '0.json'), outputs.zero);
    await writeJson(join(path, 'enhanced.json'), outputs.enhanced);
    await writeJson(join(path, 'trades.json'), outputs.trades);
  }
}

export async function regenerateSummary(root, timestamp) {
  const months = (await directories(join(root, 'daily'))).filter((name) => /^\d{4}-\d{2}$/.test(name)).reverse();
  const selected = [];
  for (const month of months) {
    const path = join(root, 'daily', month);
    const zero = await readJson(join(path, '0.json'));
    const enhanced = await readJson(join(path, 'enhanced.json'));
    const trades = await readJson(join(path, 'trades.json'));
    for (let index = zero.days.length - 1; index >= 0 && selected.length < 7; index--) {
      if (zero.days[index] <= utcDay(timestamp)) selected.push({ index, zero, enhanced, trades });
    }
    if (selected.length === 7) break;
  }
  const states = {};
  for (const { index, zero, enhanced, trades } of selected) {
    for (const [hrid, levels] of Object.entries(trades.items)) {
      for (const [level, rows] of Object.entries(levels)) {
        if (rows[index] === null) continue;
        const state = (states[hrid] ??= {})[level] ??= accumulator();
        const tuple = level === '0' ? zero.items[hrid][index] : enhanced.items[hrid][level][index];
        if (tuple[0] > 0) state.asks.push(tuple[0]);
        if (tuple[1] > 0) state.bids.push(tuple[1]);
        state.value += rows[index][0];
        state.volume += rows[index][1];
      }
    }
  }
  const items = {};
  for (const hrid of Object.keys(states).sort()) {
    const levels = items[hrid] = {};
    for (const [level, state] of Object.entries(states[hrid])) {
      levels[level] = [state.volume ? Math.round(state.value / state.volume) : null,
        Math.round(state.volume / selected.length * 10) / 10, median(state.asks), median(state.bids)];
    }
  }
  await writeJson(join(root, 'summary.json'), { timestamp, items });
  return { days: selected.length, items: Object.keys(items).length };
}
