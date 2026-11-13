/**
 * Small rolling samples of how long things take, kept in Durable Object storage and
 * summarised on /api/gateway/status. Seconds, never message content.
 */

const KEEP = 200;

export type Samples = Record<string, number[]>;

export interface Summary {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export async function addSample(storage: DurableObjectStorage, name: string, seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  const all = (await storage.get<Samples>('metrics')) ?? {};
  const list = all[name] ?? [];
  list.push(Math.round(seconds * 10) / 10);
  all[name] = list.slice(-KEEP);
  await storage.put('metrics', all);
}

export function summarize(values: number[]): Summary {
  if (!values.length) return { count: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

export function summarizeAll(samples: Samples | undefined): Record<string, Summary> {
  return Object.fromEntries(Object.entries(samples ?? {}).map(([k, v]) => [k, summarize(v)]));
}
