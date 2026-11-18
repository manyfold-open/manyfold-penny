/**
 * The daily recap: which groups are due it, and that each gets one a day.
 */
import { describe, expect, it } from 'vitest';
import { DAILY_HOUR, dailyDue, localDateHour } from '../src/worker/gateway/daily';
import { envelope } from '../src/worker/gateway/envelope';
import type { InboundMessage } from '../src/worker/gateway/inbound';
import type { NarraApi } from '../src/worker/gateway/narra-api';
import { DAILY_CHECK_MS, tick, type Sink } from '../src/worker/gateway/poller';
import type { Store } from '../src/worker/gateway/queue';

class MemoryStore implements Store {
  data = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    return this.data.delete(key);
  }
  async list<T>({ prefix, limit }: { prefix: string; limit?: number }) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit ?? Infinity);
    return new Map(keys.map((k) => [k, this.data.get(k) as T]));
  }
}

const at = (iso: string) => Date.parse(iso);

describe('which groups are due their daily recap', () => {
  it('reads date and hour in the group\'s own time zone', () => {
    expect(localDateHour('Asia/Taipei', at('2026-11-18T13:30:00Z'))).toEqual({ date: '2026-11-18', hour: 21 });
    expect(localDateHour('Europe/London', at('2026-11-18T23:30:00Z'))).toEqual({ date: '2026-11-18', hour: 23 });
    expect(localDateHour('Asia/Taipei', at('2026-11-18T16:30:00Z'))).toEqual({ date: '2026-11-19', hour: 0 });
  });

  it('picks a group past 9pm in its own time that recorded something today', () => {
    const groups = [
      { id: '!taipei:x', zone: 'Asia/Taipei' },
      { id: '!london:x', zone: 'Europe/London' },
      { id: '!quiet:x', zone: 'Asia/Taipei' },
    ];
    const entries = [
      { groupId: '!taipei:x', createdAt: '2026-11-18T04:00:00Z' }, // 12:00 in Taipei, today
      { groupId: '!london:x', createdAt: '2026-11-18T10:00:00Z' },
      { groupId: '!quiet:x', createdAt: '2026-11-17T04:00:00Z' }, // yesterday in Taipei
    ];
    // 21:30 in Taipei, 13:30 in London.
    expect(dailyDue(groups, entries, at('2026-11-18T13:30:00Z'))).toEqual([{ roomId: '!taipei:x', date: '2026-11-18' }]);
    // 21:05 in London.
    expect(dailyDue(groups, entries, at('2026-11-18T21:05:00Z')).map((d) => d.roomId)).toEqual(['!london:x']);
    expect(DAILY_HOUR).toBe(21);
  });
});

describe('the poller sending the daily recap', () => {
  const setup = (due: { roomId: string; date: string }[]) => {
    const api: NarraApi = {
      rooms: async () => ({
        agentId: '@agent-54ebea3a:x',
        rooms: [
          { roomId: '!a:x', type: 'group', title: '倫敦', memberCount: 3, names: {} },
          { roomId: '!dm:x', type: 'dm', title: '', memberCount: 2, names: {} },
        ],
      }),
      head: async () => 't0',
      after: async () => ({ events: [], next: null }),
    };
    const delivered: { message: InboundMessage; verdict: string }[] = [];
    let checks = 0;
    const s: Sink = {
      botNames: async () => [],
      hasPending: async () => false,
      dailyDue: async () => {
        checks++;
        return due;
      },
      deliver: async (message, verdict) => {
        delivered.push({ message, verdict });
      },
      log: () => undefined,
    };
    return { store: new MemoryStore(), api, s, delivered, checks: () => checks };
  };

  it('queues one recap a day for a due group, asking the ledger at most once a minute', async () => {
    const t = setup([{ roomId: '!a:x', date: '2026-11-18' }, { roomId: '!dm:x', date: '2026-11-18' }, { roomId: '!gone:x', date: '2026-11-18' }]);
    const now = 1_000_000;
    await tick(t.store, t.api, t.s, now);
    await tick(t.store, t.api, t.s, now + 4_000);
    expect(t.checks()).toBe(1);
    await tick(t.store, t.api, t.s, now + DAILY_CHECK_MS);
    expect(t.checks()).toBe(2);
    expect(t.delivered.map((d) => [d.message.text, d.verdict, d.message.nudge])).toEqual([['[penny nudge] daily 2026-11-18', 'nudge', 'daily']]);
    expect(t.delivered[0].message.eventId).toBe('nudge:daily:!a:x:2026-11-18');
    expect(envelope(t.delivered[0].message, 'nudge')).toContain('nudge: daily');
  });
});
