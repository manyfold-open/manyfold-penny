/**
 * How long a message waits before the gateway reads it, as the number of rooms grows.
 * `npm run simulate` prints the full table; the test keeps the current scale honest.
 */
import { describe, expect, it } from 'vitest';
import { simulate } from './support/simulate-gateway';

describe('gateway capacity', () => {
  it('reads every message within half a minute at today\'s scale, and stays inside Narra\'s limit', async () => {
    const r = await simulate({ rooms: 5, busy: 1 });
    expect(r.all.count).toBeGreaterThan(100);
    expect(r.quiet.max).toBeLessThanOrEqual(30);
    expect(r.busy.p95).toBeLessThanOrEqual(16);
    expect(r.readsPerMinute).toBeLessThanOrEqual(15);
  });

  it.runIf(process.env.SIMULATE)('prints the table', { timeout: 120_000 }, async () => {
    const rows: string[] = ['rooms  busy  reads/min  busy p50/p95/max (s)  quiet p50/p95/max (s)'];
    for (const [rooms, busy] of [
      [5, 1],
      [15, 2],
      [50, 5],
      [100, 10],
      [200, 20],
    ]) {
      const r = await simulate({ rooms, busy });
      rows.push(
        `${String(rooms).padStart(5)}  ${String(busy).padStart(4)}  ${String(r.readsPerMinute).padStart(9)}  ` +
          `${`${r.busy.p50}/${r.busy.p95}/${r.busy.max}`.padStart(20)}  ${`${r.quiet.p50}/${r.quiet.p95}/${r.quiet.max}`.padStart(21)}`,
      );
    }
    console.log(`\n${rows.join('\n')}\n`);
  });
});
