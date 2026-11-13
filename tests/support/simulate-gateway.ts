/**
 * Runs the real gateway poller (`tick`) against a simulated Narra with many rooms and a
 * simulated clock, and measures how long each message waits before the gateway reads it.
 *
 * Model: `rooms` rooms. `busy` of them hold a conversation (a message to Penny every
 * `busyEveryS` seconds for the whole run); the rest are quiet (a message every `quietEveryS`
 * seconds on average, at random). Every message mentions Penny, so the filter passes it.
 * Penny's own Narra reads are not simulated: the poller already keeps to its own 15 a minute.
 */

import { tick, type Sink } from '../../src/worker/gateway/poller';
import type { NarraApi, NarraEvent } from '../../src/worker/gateway/narra-api';
import type { Store } from '../../src/worker/gateway/queue';

export interface Scenario {
  rooms: number;
  busy: number;
  busyEveryS?: number;
  quietEveryS?: number;
  durationS?: number;
  seed?: number;
}

export interface Lags {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface Result {
  scenario: Required<Scenario>;
  reads: number;
  readsPerMinute: number;
  /** Seconds from a message being sent to the gateway reading it. */
  busy: Lags;
  quiet: Lags;
  all: Lags;
}

class MemoryStore implements Store {
  data = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    return this.data.delete(key);
  }
  async list<T>({ prefix, limit }: { prefix: string; limit?: number }) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit ?? Infinity);
    return new Map(keys.map((k) => [k, this.data.get(k) as T]));
  }
}

/** Small deterministic PRNG, so a scenario always gives the same numbers. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function summarize(values: number[]): Lags {
  if (!values.length) return { count: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { count: sorted.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(sorted[sorted.length - 1]) };
}

const PENNY = '@agent-penny:x';

export async function simulate(input: Scenario): Promise<Result> {
  const scenario: Required<Scenario> = { busyEveryS: 30, quietEveryS: 1800, durationS: 3600, seed: 1, ...input };
  const random = rng(scenario.seed);
  const start = 1_800_000_000_000;
  const warmup = 120_000; // let the poller find every room and take its starting position
  const end = start + warmup + scenario.durationS * 1000;

  // Every message every room will get, by send time.
  const timeline = new Map<string, { ts: number; id: string }[]>();
  const busyRooms = new Set<string>();
  let n = 0;
  for (let r = 0; r < scenario.rooms; r++) {
    const roomId = `!room${r}:x`;
    const events: { ts: number; id: string }[] = [];
    if (r < scenario.busy) {
      busyRooms.add(roomId);
      for (let t = start + warmup; t < end; t += scenario.busyEveryS * 1000) events.push({ ts: t, id: `$${n++}` });
    } else {
      let t = start + warmup + -Math.log(1 - random()) * scenario.quietEveryS * 1000;
      while (t < end) {
        events.push({ ts: Math.round(t), id: `$${n++}` });
        t += -Math.log(1 - random()) * scenario.quietEveryS * 1000;
      }
    }
    timeline.set(roomId, events);
  }

  let now = start;
  let reads = 0;
  const api: NarraApi = {
    rooms: async () => ({
      agentId: PENNY,
      rooms: [...timeline.keys()].map((roomId) => ({ roomId, type: 'group' as const, title: '', memberCount: 4, names: {} })),
    }),
    head: async () => {
      reads++;
      return String(now);
    },
    after: async (roomId, from) => {
      reads++;
      const since = Number(from);
      const events: NarraEvent[] = timeline
        .get(roomId)!
        .filter((e) => e.ts > since && e.ts <= now)
        .slice(0, 50)
        .map((e) => ({
          event_id: e.id,
          sender: '@mei:x',
          origin_server_ts: e.ts,
          type: 'm.room.message',
          content: { msgtype: 'm.text', body: '@Penny 誰欠誰', 'm.mentions': { user_ids: [PENNY] } },
        }));
      const last = events.at(-1);
      return { events, next: last ? String(last.origin_server_ts) : null };
    },
  };

  const busyLags: number[] = [];
  const quietLags: number[] = [];
  const sink: Sink = {
    botNames: async () => [],
    deliver: async (message) => {
      const lag = (now - Date.parse(message.time)) / 1000;
      (busyRooms.has(message.roomId) ? busyLags : quietLags).push(lag);
    },
    log: () => undefined,
  };

  const store = new MemoryStore();
  while (now < end + 15 * 60_000) {
    now += await tick(store, api, sink, now);
  }

  return {
    scenario,
    reads,
    readsPerMinute: Math.round((reads / ((now - start) / 60_000)) * 10) / 10,
    busy: summarize(busyLags),
    quiet: summarize(quietLags),
    all: summarize([...busyLags, ...quietLags]),
  };
}
