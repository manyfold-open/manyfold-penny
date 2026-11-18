/**
 * Reads Narra in real time through Matrix /sync, so a message reaches Penny within a second
 * instead of waiting its room's turn in the poller (which Narra limits to 30 reads a minute
 * across all rooms).
 *
 * Penny's Narra bearer may fetch her own Matrix login (POST /api/agent-runtime/matrix-credential,
 * the call Narra's setup guide gives for moving to Direct Matrix). It only returns the existing
 * login: no new token, no change to how Penny is bound. The login is kept in memory only,
 * never stored or logged, and fetched again after a restart or a 401.
 *
 * One Durable Object (MatrixSync) long-polls /sync and hands each batch to the poller
 * (POST https://narra-poller/events), which sorts it exactly like a read of its own. The
 * poller keeps reading each room once a minute as a backstop: Narra may switch on a filter
 * that leaves messages not addressed to Penny out of her /sync (hybrid-im-knowledge,
 * agent-collaboration-chain-guard.md §13.6), and Penny needs those to pick up expenses.
 *
 * The logic is `syncOnce`, written against small interfaces so it runs in tests.
 */

import { safeErrorText } from '../a2a';
import type { Env } from '../types';
import type { NarraEvent } from './narra-api';
import type { SyncedRoom } from './poller';
import { gatewayEnabled } from './poller';
import type { Store } from './queue';

/** How long Synapse may hold one /sync open when nothing happens. */
export const SYNC_TIMEOUT_MS = 25_000;
const MAX_BACKOFF_MS = 60_000;

export interface MatrixLogin {
  homeserverUrl: string;
  userId: string;
  accessToken: string;
}

export class SyncError extends Error {
  /** The access token was refused: fetch the login again. */
  readonly unauthorized: boolean;

  constructor(message: string, unauthorized = false) {
    super(message);
    this.name = 'SyncError';
    this.unauthorized = unauthorized;
  }
}

export interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, { timeline?: { events?: NarraEvent[]; limited?: boolean } }>;
  };
}

export interface SyncDeps {
  login(): Promise<MatrixLogin>;
  sync(login: MatrixLogin, since: string | null, timeoutMs: number): Promise<SyncResponse>;
  /** Hand a batch to the poller. Called on every successful /sync, even an empty one, so the
   *  poller knows /sync is alive. */
  forward(rooms: SyncedRoom[]): Promise<void>;
  log(line: string): void;
}

// Only what the gateway reads: messages (which include edits) and reactions, in joined rooms.
export const SYNC_FILTER = JSON.stringify({
  presence: { types: [] },
  account_data: { types: [] },
  room: {
    timeline: { limit: 50, types: ['m.room.message', 'm.reaction'] },
    state: { types: [] },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
});

interface SyncState {
  since: string | null;
  /** Consecutive failures, for the backoff. */
  failures: number;
}

/**
 * One /sync. Returns how long to wait before the next one. The first /sync only finds the
 * live end of the timeline: like the poller, it starts from "now".
 */
export async function syncOnce(store: Store, deps: SyncDeps, cache: { login?: MatrixLogin }): Promise<number> {
  const state = (await store.get<SyncState>('sync')) ?? { since: null, failures: 0 };
  try {
    cache.login ??= await deps.login();
    const first = state.since === null;
    const response = await deps.sync(cache.login, state.since, first ? 0 : SYNC_TIMEOUT_MS);
    const rooms: SyncedRoom[] = [];
    if (!first) {
      for (const [roomId, joined] of Object.entries(response.rooms?.join ?? {})) {
        const events = (joined.timeline?.events ?? []).filter((e) => e && typeof e.event_id === 'string');
        if (events.length || joined.timeline?.limited) rooms.push({ roomId, events, limited: joined.timeline?.limited === true });
      }
    } else {
      deps.log('sync started');
    }
    await deps.forward(rooms);
    await store.put('sync', { since: response.next_batch, failures: 0 } satisfies SyncState);
    return 0;
  } catch (error) {
    if (error instanceof SyncError && error.unauthorized) cache.login = undefined;
    const failures = state.failures + 1;
    await store.put('sync', { ...state, failures } satisfies SyncState);
    deps.log(`sync failed (${failures}): ${error instanceof Error ? error.message : String(error)}`);
    return Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** (failures - 1));
  }
}

export function syncEnabled(env: Env): boolean {
  return gatewayEnabled(env) && (env.NARRA_SYNC ?? '').trim() === 'on' && Boolean(env.MATRIX_SYNC);
}

function narraBase(env: Env): string {
  return (env.NARRA_API_ENDPOINT ?? 'https://api.netmind.chat').replace(/\/+$/, '');
}

/** Penny's Matrix login, from her own Narra bearer. */
export async function fetchLogin(env: Env): Promise<MatrixLogin> {
  const token = (env.NARRA_AGENT_TOKEN ?? '').trim();
  let response: Response;
  try {
    response = await fetch(`${narraBase(env)}/api/agent-runtime/matrix-credential`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new SyncError(`Narra unreachable: ${safeErrorText(error instanceof Error ? error.message : error)}`);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  // Narra's controllers answer either the object itself or { data: ... }.
  const data = (body && typeof body.data === 'object' && body.data ? body.data : body) as Record<string, unknown> | null;
  const homeserverUrl = typeof data?.homeserver_url === 'string' ? data.homeserver_url : '';
  const userId = typeof data?.matrix_user_id === 'string' ? data.matrix_user_id : '';
  const accessToken = typeof data?.access_token === 'string' ? data.access_token : '';
  if (!response.ok || !accessToken || !userId) {
    // Never echo the body: on success it holds the token.
    throw new SyncError(`Narra matrix-credential failed: HTTP ${response.status}`);
  }
  let url: URL;
  try {
    url = new URL(homeserverUrl);
  } catch {
    throw new SyncError('Narra gave no usable homeserver URL.');
  }
  // The token goes only to Narra's own homeserver, over https.
  if (url.protocol !== 'https:' || !(url.hostname === 'netmind.chat' || url.hostname.endsWith('.netmind.chat'))) {
    throw new SyncError(`Narra gave an unexpected homeserver (${url.hostname}).`);
  }
  return { homeserverUrl: url.origin, userId, accessToken };
}

export async function matrixSync(login: MatrixLogin, since: string | null, timeoutMs: number): Promise<SyncResponse> {
  const url = new URL(`${login.homeserverUrl}/_matrix/client/v3/sync`);
  url.searchParams.set('filter', SYNC_FILTER);
  url.searchParams.set('timeout', String(timeoutMs));
  url.searchParams.set('set_presence', 'offline');
  if (since) url.searchParams.set('since', since);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${login.accessToken}` },
      signal: AbortSignal.timeout(timeoutMs + 20_000),
    });
  } catch (error) {
    throw new SyncError(`homeserver unreachable: ${safeErrorText(error instanceof Error ? error.message : error)}`);
  }
  if (response.status === 401) throw new SyncError('homeserver refused the login (401)', true);
  const body = (await response.json().catch(() => null)) as SyncResponse | null;
  if (!response.ok || !body || typeof body.next_batch !== 'string') {
    throw new SyncError(`/sync failed: HTTP ${response.status}`);
  }
  return body;
}

/** What the queue asks MatrixSync to do as Penny (gateway/deps.ts). */
export type MatrixOp =
  | { op: 'send'; roomId: string; txnId: string; content: Record<string, unknown> }
  | { op: 'typing'; roomId: string; typing: boolean }
  | { op: 'receipt'; roomId: string; eventId: string };

export type MatrixOpResult =
  | { ok: true; eventId?: string }
  /** status 0: nothing was sent (no login, or /sync switched off), so another path may try. */
  | { ok: false; status: number; errcode?: string; narraCode?: string };

const enc = encodeURIComponent;

export async function matrixCall(login: MatrixLogin, op: MatrixOp): Promise<MatrixOpResult> {
  const base = `${login.homeserverUrl}/_matrix/client/v3/rooms/${enc(op.roomId)}`;
  let method = 'PUT';
  let url: string;
  let body: unknown;
  if (op.op === 'send') {
    url = `${base}/send/m.room.message/${enc(op.txnId)}`;
    body = op.content;
  } else if (op.op === 'typing') {
    url = `${base}/typing/${enc(login.userId)}`;
    body = op.typing ? { typing: true, timeout: 30_000 } : { typing: false };
  } else {
    method = 'POST';
    url = `${base}/receipt/m.read/${enc(op.eventId)}`;
    body = {};
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${login.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    // It may or may not have reached the homeserver: the caller retries the same txn id.
    return { ok: false, status: 599, errcode: safeErrorText(error instanceof Error ? error.message : error).slice(0, 120) };
  }
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) return { ok: true, ...(typeof parsed.event_id === 'string' ? { eventId: parsed.event_id } : {}) };
  return {
    ok: false,
    status: response.status,
    ...(typeof parsed.errcode === 'string' ? { errcode: parsed.errcode } : {}),
    ...(typeof parsed.narra_error_code === 'string' ? { narraCode: parsed.narra_error_code } : {}),
  };
}

/** The single /sync reader. Addressed as env.MATRIX_SYNC.idFromName('narra'). */
export class MatrixSync {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  /** Penny's Matrix login: in memory only. */
  private readonly cache: { login?: MatrixLogin } = {};

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private store(): Store {
    const s = this.state.storage;
    return {
      get: (key) => s.get(key),
      put: (key, value) => s.put(key, value),
      delete: (key) => s.delete(key),
      list: (options) => s.list(options),
    };
  }

  /** Called by the cron trigger: keep the loop running, or stop it when switched off. */
  async fetch(request?: Request): Promise<Response> {
    if (request?.method === 'POST' && new URL(request.url).pathname.endsWith('/matrix')) {
      return Response.json(await this.act((await request.json()) as MatrixOp));
    }
    if (request && new URL(request.url).pathname.endsWith('/status')) {
      const sync = (await this.state.storage.get<SyncState>('sync')) ?? null;
      return Response.json({
        enabled: syncEnabled(this.env),
        alarm: await this.state.storage.getAlarm(),
        started: Boolean(sync?.since),
        failures: sync?.failures ?? 0,
        lastOk: (await this.state.storage.get<number>('lastOk')) ?? null,
      });
    }
    if (!syncEnabled(this.env)) {
      await this.state.storage.deleteAlarm();
      return Response.json({ running: false });
    }
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now());
    return Response.json({ running: true });
  }

  /** Send, type or mark read as Penny. The login never leaves this object. */
  private async act(op: MatrixOp): Promise<MatrixOpResult> {
    if (!syncEnabled(this.env)) return { ok: false, status: 0, errcode: 'SYNC_OFF' };
    try {
      this.cache.login ??= await fetchLogin(this.env);
    } catch {
      return { ok: false, status: 0, errcode: 'NO_LOGIN' };
    }
    const result = await matrixCall(this.cache.login, op);
    if (!result.ok && result.status === 401) this.cache.login = undefined;
    return result;
  }

  async alarm(): Promise<void> {
    if (!syncEnabled(this.env)) return;
    const env = this.env;
    const storage = this.state.storage;
    const poller = env.NARRA_POLLER!.get(env.NARRA_POLLER!.idFromName('narra'));
    const delay = await syncOnce(
      this.store(),
      {
        login: () => fetchLogin(env),
        sync: matrixSync,
        async forward(rooms) {
          const response = await poller.fetch('https://narra-poller/events', { method: 'POST', body: JSON.stringify({ rooms }) });
          if (!response.ok) throw new SyncError(`poller refused the batch: HTTP ${response.status}`);
          await storage.put('lastOk', Date.now());
        },
        log: (line) => {
          console.log(`[sync] ${line}`);
          // The poller's log is what /api/gateway/status shows.
          void poller.fetch('https://narra-poller/log', { method: 'POST', body: JSON.stringify({ line: `sync: ${line}` }) }).catch(() => undefined);
        },
      },
      this.cache,
    );
    await storage.setAlarm(Date.now() + delay);
  }
}
