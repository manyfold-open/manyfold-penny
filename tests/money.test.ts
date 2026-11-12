import { describe, expect, it } from 'vitest';
import { allocate, checkPayers, computeShares, simplifyDebts } from '../src/worker/ledger/money';

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

describe('computeShares', () => {
  it('splits evenly and hands leftover pence to the first members', () => {
    expect(computeShares(1000, { method: 'equal', members: ['a', 'b', 'c'] })).toEqual({ a: 334, b: 333, c: 333 });
  });

  it('applies adjustments and lets the others absorb them', () => {
    // Dinner £120, Ken pays £8 less: everyone else £32, Ken £24.
    expect(
      computeShares(12000, { method: 'equal', members: ['zack', 'mei', 'ken', 'ray'], adjustments: { ken: -800 } }),
    ).toEqual({ zack: 3200, mei: 3200, ken: 2400, ray: 3200 });
  });

  it('splits by percent', () => {
    expect(computeShares(9400, { method: 'percent', percents: { zack: 40, mei: 60 } })).toEqual({ zack: 3760, mei: 5640 });
  });

  it('splits by shares', () => {
    expect(computeShares(900, { method: 'shares', shares: { a: 2, b: 1 } })).toEqual({ a: 600, b: 300 });
  });

  it('splits a receipt item by item and spreads the service charge in proportion', () => {
    const shares = computeShares(9900, {
      method: 'items',
      everyone: ['ray', 'ken', 'mei', 'zack'],
      items: [
        { amount: 1900, members: ['ray'] },
        { amount: 1700, members: ['ken'] },
        { amount: 1200 },
        { amount: 1000, members: ['mei', 'zack'] },
        { amount: 3000 },
      ],
      extra: 1100,
    });
    expect(shares).toEqual({ ray: 3319, ken: 3094, mei: 1744, zack: 1743 });
  });

  it('treats a one-person split as an advance', () => {
    expect(computeShares(2000, { method: 'equal', members: ['ken'] })).toEqual({ ken: 2000 });
  });

  it('rejects splits that do not add up', () => {
    expect(() => computeShares(1000, { method: 'exact', amounts: { a: 600, b: 300 } })).toThrow(/add up to 900/);
    expect(() => computeShares(1000, { method: 'percent', percents: { a: 50, b: 40 } })).toThrow(/100/);
    expect(() => computeShares(1000, { method: 'equal', members: ['a', 'a'] })).toThrow(/twice/);
    expect(() => computeShares(1000, { method: 'equal', members: ['a', 'b'], adjustments: { a: -2000 } })).toThrow();
    expect(() => computeShares(10.5, { method: 'equal', members: ['a'] })).toThrow(/integer/);
  });

  it('always adds up to the total', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      const total = 1 + rand(10_000_000);
      const members = Array.from({ length: 1 + rand(12) }, (_, k) => `m${k}`);
      const weights = Object.fromEntries(members.map((m) => [m, 1 + rand(9)]));
      expect(sum(computeShares(total, { method: 'equal', members }))).toBe(total);
      expect(sum(computeShares(total, { method: 'shares', shares: weights }))).toBe(total);
    }
  });
});

describe('allocate', () => {
  it('is deterministic and breaks ties by order', () => {
    expect(allocate(2, [['x', 1], ['y', 1], ['z', 1]])).toEqual({ x: 1, y: 1, z: 0 });
    expect(allocate(2, [['z', 1], ['y', 1], ['x', 1]])).toEqual({ z: 1, y: 1, x: 0 });
  });
});

describe('checkPayers', () => {
  it('requires payers to add up to the total', () => {
    expect(checkPayers(2400, [{ member: 'a', amount: 1000 }, { member: 'b', amount: 1400 }])).toHaveLength(2);
    expect(() => checkPayers(2400, [{ member: 'a', amount: 1000 }])).toThrow(/add up/);
  });
});

describe('simplifyDebts', () => {
  it('produces the settle-up plan from the prototype', () => {
    expect(simplifyDebts({ zack: 21000, ray: 4000, ken: -7500, mei: -17500 })).toEqual([
      { from: 'mei', to: 'zack', amount: 17500 },
      { from: 'ken', to: 'ray', amount: 4000 },
      { from: 'ken', to: 'zack', amount: 3500 },
    ]);
  });

  it('settles every balance with at most n - 1 transfers', () => {
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 500; i++) {
      const n = 2 + rand(15);
      const nets: Record<string, number> = {};
      let total = 0;
      for (let k = 0; k < n - 1; k++) {
        nets[`m${k}`] = rand(200_000) - 100_000;
        total += nets[`m${k}`];
      }
      nets[`m${n - 1}`] = -total;
      const transfers = simplifyDebts(nets);
      expect(transfers.length).toBeLessThanOrEqual(n - 1);
      const after = { ...nets };
      for (const t of transfers) {
        expect(t.amount).toBeGreaterThan(0);
        after[t.from] += t.amount;
        after[t.to] -= t.amount;
      }
      expect(Object.values(after).every((v) => v === 0)).toBe(true);
    }
  });
});
