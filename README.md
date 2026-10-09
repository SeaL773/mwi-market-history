# MWI Market History

[![Collect](https://github.com/SeaL773/mwi-market-history/actions/workflows/collect.yml/badge.svg)](https://github.com/SeaL773/mwi-market-history/actions/workflows/collect.yml)
[![Last update](https://img.shields.io/github/last-commit/SeaL773/mwi-market-history?label=last%20update)](https://github.com/SeaL773/mwi-market-history/commits/main)

Hourly archive of the official [Milky Way Idle](https://www.milkywayidle.com/) marketplace snapshot, with daily
aggregates and a 7-day summary. It powers the market history in
[MWI Combat Simulator](https://seal773.github.io/MWICombatSimulatorTest/) price settings and is free for anyone to use.

- **Official source only.** Every hour a GitHub Action saves `marketplace.json` from the game, byte for byte.
- **Static files.** No API or server: fetch JSON straight from GitHub, CORS enabled.
- **Small reads.** The 7-day summary of every item is about 27 KB gzipped.

## Using the data

Base URL: `https://raw.githubusercontent.com/SeaL773/mwi-market-history/main/`

| File | Content | Size |
| --- | --- | --- |
| [`summary.json`](summary.json) | Last 7 days for every item and enhancement level | ~110 KB (~27 KB gzip) |
| `daily/YYYY-MM/0.json` | Daily ask, bid, average price and volume of unenhanced items | ~650 KB per month |
| `daily/YYYY-MM/enhanced.json` | The same for enhancement levels above 0 | varies |
| `raw/YYYY-MM-DD/HH.json.gz` | The official snapshot, gzip-compressed, named by its UTC time | ~30 KB each |

```js
const BASE = "https://raw.githubusercontent.com/SeaL773/mwi-market-history/main/";
const summary = await fetch(BASE + "summary.json").then((r) => r.json());
const [avg7, volumePerDay, ask7, bid7] = summary.items["/items/holy_cheese"]["0"];
```

All dates and hours are UTC. `null` means no data; a day without trades has volume `0`.

## File formats

### `summary.json`

```jsonc
{
  "timestamp": 1791511560, // Unix seconds of the latest official snapshot
  "items": {
    "/items/abyssal_essence": {
      "0": [184, 13492777.1, 185, 182] // [avg7, volume7, ask7, bid7] for enhancement level 0
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `avg7` | Volume-weighted average trade price over the last 7 days with data, rounded |
| `volume7` | Average daily trade volume over those days, one decimal |
| `ask7` / `bid7` | Median of the daily best ask / best bid |

The window includes the current, partial day.

### `daily/YYYY-MM/0.json`

```jsonc
{
  "days": ["2026-10-01", "2026-10-02"],
  "items": {
    "/items/abyssal_essence": [[187, 184, 185, 10147503], null] // one row per day: [ask, bid, avg, volume]
  }
}
```

Rows line up with `days`. `ask` and `bid` are medians of the hourly quotes, `avg` is the volume-weighted trade price,
`volume` is the day's total. `enhanced.json` has the same layout with rows nested by level:
`items[hrid][level] = [[ask, bid, avg, volume] | null, ...]`.

`trades.json` holds exact `[sum(price × volume), sum(volume)]` pairs used to build the summary without rounding twice;
consumers don't need it.

### `raw/YYYY-MM-DD/HH.json.gz`

The game's `marketplace.json` exactly as served, `{ timestamp, marketData: { hrid: { level: { a, b, p, v } } } }`,
where `a`/`b` are the best ask/bid and `p`/`v` the last hour's average trade price and volume.

## Coverage

| Period | Source | Levels |
| --- | --- | --- |
| 2026-03-10 to 2026-10-08 | One-time import from [Mooket](https://q7.nainai.eu.org/) history | 0 only |
| 2026-10-09 02:06 UTC onward | Official hourly snapshots | All |

Missing hours are never interpolated.

## How it works

[`collect.yml`](.github/workflows/collect.yml) runs at minute 15 of every hour, a few minutes after the game publishes a
new snapshot. [`scripts/collect.mjs`](scripts/collect.mjs) (Node 24, no dependencies) saves the raw file, rebuilds that
day's rows and regenerates `summary.json`. The workflow checks out only `scripts/`, `daily/` and the current raw day, so
the job stays fast as the archive grows.

```sh
node --test scripts/archive.test.mjs   # aggregation tests
node scripts/collect.mjs               # collect the current snapshot locally
```

`scripts/backfill.mjs` was the one-time Mooket import; it only writes days before the first official snapshot.

## Notes

- GitHub can delay or skip scheduled runs; check the badge above or the `timestamp` in `summary.json` for freshness.
- GitHub disables scheduled workflows after 60 days without repository activity. The hourly commits keep it active.
- Raw snapshots add about 700 KB per day.
