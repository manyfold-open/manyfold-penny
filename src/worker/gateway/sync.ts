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
 * Push mode (NARRA_SYNC_MODE=push): instead of holding a /sync open around the clock (Cloudflare
 * bills a Durable Object for that whole wait), MatrixSync registers a Matrix HTTP pusher for
 * Penny's account pointing at this Worker, and Synapse calls POST /_matrix/push/v1/notify for every
 * new event. That only wakes MatrixSync, which runs a /sync that does not wait. A /sync still runs
 * once a minute in case a push is lost, and if the pusher cannot be registered it long-polls as before.
 *
 * Invites: Narra starts a new user's DM (and adds Penny to a group) with Penny only invited, so
 * MatrixSync joins every invite it sees, and every 30 minutes lists all pending ones (incremental
 * /sync reports an invite once). The poller is told, so it can read the room's first messages.
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
    /** Rooms Penny is invited to but has not joined. */
    invite?: Record<string, unknown>;
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

// Only what the gateway reads: messages (which include edits), reactions, and redactions, in joined rooms.
export const SYNC_FILTER = JSON.stringify({
  presence: { types: [] },
  account_data: { types: [] },
  room: {
    timeline: { limit: 50, types: ['m.room.message', 'm.reaction', 'm.room.redaction'] },
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
export async function syncOnce(
  store: Store,
  deps: SyncDeps,
  cache: { login?: MatrixLogin },
  timeoutMs = SYNC_TIMEOUT_MS,
): Promise<number> {
  const state = (await store.get<SyncState>('sync')) ?? { since: null, failures: 0 };
  try {
    cache.login ??= await deps.login();
    const first = state.since === null;
    const response = await deps.sync(cache.login, state.since, first ? 0 : timeoutMs);
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

/** Synapse refuses a pusher whose URL path is anything but exactly this. */
export const PUSH_NOTIFY_PATH = '/_matrix/push/v1/notify';
export const PUSHER_APP_ID = 'ai.manyfold.penny';
/** User-defined override rule: every event notifies (edits, redactions and reactions are silent by default). */
export const WAKE_RULE_ID = 'ai.manyfold.penny.wake';
/** In push mode, a /sync that does not wait still runs this often in case a push is lost. */
export const PUSH_BACKSTOP_MS = 60_000;
const PUSH_SETUP_REFRESH_MS = 6 * 60 * 60_000;
const INVITE_SWEEP_EVERY_MS = 30 * 60_000;
const INVITE_RETRY_BASE_MS = 60_000;
const INVITE_RETRY_MAX_MS = 6 * 60 * 60_000;
const INVITE_SWEEP_FILTER = JSON.stringify({
  presence: { types: [] },
  account_data: { types: [] },
  room: { timeline: { limit: 0 }, state: { types: [] }, ephemeral: { types: [] }, account_data: { types: [] } },
});

function pushSecret(env: Env): string {
  return (env.NARRA_PUSH_SECRET ?? '').trim();
}

/** The pusher URL: the https origin of NARRA_PUSH_URL plus the fixed notify path. */
export function pushNotifyUrl(env: Env): string | null {
  const base = (env.NARRA_PUSH_URL ?? '').trim();
  if (!base || pushSecret(env).length < 16) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  return url.protocol === 'https:' ? `${url.origin}${PUSH_NOTIFY_PATH}` : null;
}

/** Derived from NARRA_PUSH_SECRET; Synapse echoes it in every push, which is how real pushes are told apart. */
export async function pushKey(env: Env): Promise<string | null> {
  const secret = pushSecret(env);
  if (secret.length < 16) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`penny:pushkey:${secret}`)));
  return `penny:${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function pushModeEnabled(env: Env): boolean {
  return syncEnabled(env) && (env.NARRA_SYNC_MODE ?? '').trim() === 'push' && pushNotifyUrl(env) !== null;
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Synapse's pusher call (POST /_matrix/push/v1/notify). Returns null for any other request.
 * Wakes MatrixSync when the pushkey is Penny's; otherwise answers with the pushkeys rejected,
 * which makes Synapse drop the stale pusher.
 */
export async function handlePushRequest(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== PUSH_NOTIFY_PATH) return null;
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  const body = (await request.json().catch(() => null)) as { notification?: { devices?: unknown } } | null;
  const devices = Array.isArray(body?.notification?.devices) ? (body!.notification!.devices as unknown[]) : [];
  const pushkeys = devices
    .map((d) => (d as { pushkey?: unknown } | null)?.pushkey)
    .filter((k): k is string => typeof k === 'string');
  const expected = await pushKey(env);
  const authentic = expected !== null && pushkeys.some((k) => sameText(k, expected));
  if (!pushModeEnabled(env) || !authentic) return Response.json({ rejected: pushkeys });
  await env.MATRIX_SYNC!.get(env.MATRIX_SYNC!.idFromName('narra')).fetch('https://matrix-sync/push', { method: 'POST' });
  return Response.json({ rejected: [] });
}

async function errorSnippet(response: Response): Promise<string> {
  return (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
}

interface PushSetup {
  url: string;
  pushkey: string;
  at: number;
}

interface InviteAttempt {
  failures: number;
  nextAt: number;
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
        mode: pushModeEnabled(this.env) ? 'push' : 'longpoll',
        pushRegisteredAt: (await this.state.storage.get<PushSetup>('pushSetup'))?.at ?? null,
        alarm: await this.state.storage.getAlarm(),
        started: Boolean(sync?.since),
        failures: sync?.failures ?? 0,
        lastOk: (await this.state.storage.get<number>('lastOk')) ?? null,
      });
    }
    if (request?.method === 'POST' && new URL(request.url).pathname.endsWith('/push')) {
      if (!pushModeEnabled(this.env)) return Response.json({ woke: false });
      const storage = this.state.storage;
      await storage.put('pushSeq', ((await storage.get<number>('pushSeq')) ?? 0) + 1);
      const now = Date.now();
      const alarm = await storage.getAlarm();
      if (alarm === null || alarm > now) await storage.setAlarm(now);
      return Response.json({ woke: true });
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

  private log(line: string): void {
    console.log(`[sync] ${line}`);
    // The poller's log is what /api/gateway/status shows.
    void this.env
      .NARRA_POLLER!.get(this.env.NARRA_POLLER!.idFromName('narra'))
      .fetch('https://narra-poller/log', { method: 'POST', body: JSON.stringify({ line: `sync: ${line}` }) })
      .catch(() => undefined);
  }

  private async homeserver(login: MatrixLogin, method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${login.homeserverUrl}/_matrix/client/v3${path}`, {
      method,
      headers: {
        authorization: `Bearer ${login.accessToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  /** Registers (and re-asserts every 6 hours) the pusher and the wake rule. False: long-poll this round. */
  private async ensurePushSetup(now: number): Promise<boolean> {
    const url = pushNotifyUrl(this.env);
    const pushkey = await pushKey(this.env);
    if (!url || !pushkey) return false;
    const storage = this.state.storage;
    const stored = await storage.get<PushSetup>('pushSetup');
    if (stored && stored.url === url && stored.pushkey === pushkey && now - stored.at < PUSH_SETUP_REFRESH_MS) return true;
    try {
      const login = (this.cache.login ??= await fetchLogin(this.env));
      const rule = await this.homeserver(login, 'PUT', `/pushrules/global/override/${enc(WAKE_RULE_ID)}`, {
        conditions: [],
        actions: ['notify'],
      });
      if (rule.status === 401) this.cache.login = undefined;
      if (!rule.ok) throw new Error(`push rule HTTP ${rule.status} ${await errorSnippet(rule)}`);
      const pusher = await this.homeserver(login, 'POST', '/pushers/set', {
        kind: 'http',
        app_id: PUSHER_APP_ID,
        pushkey,
        app_display_name: 'Penny',
        device_display_name: 'Penny gateway',
        lang: 'en',
        append: false,
        data: { url, format: 'event_id_only' },
      });
      if (pusher.status === 401) this.cache.login = undefined;
      if (!pusher.ok) throw new Error(`pusher HTTP ${pusher.status} ${await errorSnippet(pusher)}`);
      await storage.put('pushSetup', { url, pushkey, at: now } satisfies PushSetup);
      this.log('push mode: pusher and wake rule registered');
      return true;
    } catch (error) {
      this.log(`push setup failed, long-polling: ${safeErrorText(error instanceof Error ? error.message : error)}`);
      return false;
    }
  }

  /** After switching back to long-poll: remove the pusher and the wake rule (best effort). */
  private async teardownPushSetup(): Promise<void> {
    const storage = this.state.storage;
    const stored = await storage.get<PushSetup>('pushSetup');
    if (!stored) return;
    try {
      const login = (this.cache.login ??= await fetchLogin(this.env));
      await this.homeserver(login, 'POST', '/pushers/set', { kind: null, app_id: PUSHER_APP_ID, pushkey: stored.pushkey });
      await this.homeserver(login, 'DELETE', `/pushrules/global/override/${enc(WAKE_RULE_ID)}`);
    } catch {
      // A stale pusher's pushes are rejected by handlePushRequest, and Synapse then drops it.
    }
    await storage.delete('pushSetup');
  }

  /** Joins the rooms in `invite`; tells the poller about the ones joined. Returns how many. */
  private async acceptInvites(response: SyncResponse, now: number): Promise<number> {
    const invited = Object.keys(response.rooms?.invite ?? {});
    const login = this.cache.login;
    if (invited.length === 0 || !login) return 0;
    const storage = this.state.storage;
    const attempts = (await storage.get<Record<string, InviteAttempt>>('inviteAttempts')) ?? {};
    const joined: string[] = [];
    for (const roomId of invited) {
      const prior = attempts[roomId];
      if (prior && prior.nextAt > now) continue;
      let result: Response;
      try {
        result = await this.homeserver(login, 'POST', `/rooms/${enc(roomId)}/join`, {});
      } catch (error) {
        result = new Response(safeErrorText(error instanceof Error ? error.message : error), { status: 599 });
      }
      if (result.ok) {
        delete attempts[roomId];
        joined.push(roomId);
        this.log(`accepted invite to ${roomId}`);
        continue;
      }
      if (result.status === 401) this.cache.login = undefined;
      const failures = (prior?.failures ?? 0) + 1;
      attempts[roomId] = { failures, nextAt: now + Math.min(INVITE_RETRY_MAX_MS, INVITE_RETRY_BASE_MS * 2 ** (failures - 1)) };
      this.log(`invite join failed for ${roomId} (${failures}): HTTP ${result.status} ${await errorSnippet(result)}`);
    }
    for (const roomId of Object.keys(attempts)) if (!invited.includes(roomId)) delete attempts[roomId];
    await storage.put('inviteAttempts', attempts);
    if (joined.length) {
      const poller = this.env.NARRA_POLLER!.get(this.env.NARRA_POLLER!.idFromName('narra'));
      await poller.fetch('https://narra-poller/joined', { method: 'POST', body: JSON.stringify({ roomIds: joined }) }).catch(() => undefined);
    }
    return joined.length;
  }

  /** Incremental /sync reports an invite once: every 30 minutes, list all pending ones. */
  private async sweepInvites(now: number): Promise<number> {
    const storage = this.state.storage;
    if (now - ((await storage.get<number>('inviteSweepAt')) ?? 0) < INVITE_SWEEP_EVERY_MS) return 0;
    if (!(await storage.get<SyncState>('sync'))?.since) {
      // The first /sync lists every invite anyway.
      await storage.put('inviteSweepAt', now);
      return 0;
    }
    try {
      const login = (this.cache.login ??= await fetchLogin(this.env));
      const response = await this.homeserver(
        login,
        'GET',
        `/sync?timeout=0&set_presence=offline&filter=${enc(INVITE_SWEEP_FILTER)}`,
      );
      if (response.status === 401) this.cache.login = undefined;
      if (!response.ok) throw new Error(`HTTP ${response.status} ${await errorSnippet(response)}`);
      await storage.put('inviteSweepAt', now);
      return await this.acceptInvites((await response.json()) as SyncResponse, now);
    } catch (error) {
      this.log(`invite sweep failed: ${safeErrorText(error instanceof Error ? error.message : error)}`);
      return 0;
    }
  }

  async alarm(): Promise<void> {
    if (!syncEnabled(this.env)) return;
    const env = this.env;
    const storage = this.state.storage;
    const poller = env.NARRA_POLLER!.get(env.NARRA_POLLER!.idFromName('narra'));
    const now = Date.now();
    const pushReady = pushModeEnabled(env) ? await this.ensurePushSetup(now) : (await this.teardownPushSetup(), false);
    const pushSeqAtStart = (await storage.get<number>('pushSeq')) ?? 0;
    let joined = await this.sweepInvites(now);
    const self = this;
    const delay = await syncOnce(
      this.store(),
      {
        login: () => fetchLogin(env),
        async sync(login, since, timeoutMs) {
          const response = await matrixSync(login, since, timeoutMs);
          joined += await self.acceptInvites(response, now);
          return response;
        },
        async forward(rooms) {
          const response = await poller.fetch('https://narra-poller/events', {
            method: 'POST',
            body: JSON.stringify({ rooms, push: pushReady }),
          });
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
      pushReady ? 0 : SYNC_TIMEOUT_MS,
    );
    let next = delay;
    if (delay === 0 && joined > 0) next = 0;
    else if (delay === 0 && pushReady) {
      // A push that landed while this /sync ran must not wait for the backstop.
      next = ((await storage.get<number>('pushSeq')) ?? 0) !== pushSeqAtStart ? 0 : PUSH_BACKSTOP_MS;
    }
    await storage.setAlarm(Date.now() + next);
  }
}
