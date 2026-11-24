/**
 * Worker-side types. `Env` mirrors the bindings and vars declared in wrangler.jsonc —
 * if you add a binding there, add it here too.
 */

export interface Env {
  /** Static build output in dist/client. Non-/api/ requests are served from here. */
  ASSETS: Fetcher;
  /** D1 database. The starter uses five tables; the rest is yours. */
  DB: D1Database;

  /** Manyfold API base, e.g. https://api.manyfold.ai */
  MANYFOLD_API_BASE_URL?: string;
  /** "production" enables https-only and private-IP checks on agent URLs. */
  ENVIRONMENT?: string;
  /** Source commit attached by the production deployment workflow. */
  RELEASE_SHA?: string;
  /** Optional: >=32 chars. Without it a key is generated and kept in D1. */
  CONFIG_ENCRYPTION_KEY?: string;
  /** Optional: when set, all routes except /api/health and /api/state require x-admin-password. */
  ADMIN_PASSWORD?: string;
  /** Bearer key the Penny agent presents to /api/ledger/*. The ledger is off without it. */
  PENNY_API_KEY?: string;

  /* The Narra gateway (src/worker/gateway). Off unless NARRA_GATEWAY is "poll". */
  /** "poll" switches the gateway on. Anything else (or unset) leaves it off. */
  NARRA_GATEWAY?: string;
  /** The single poller that reads new messages from Narra (Durable Object NarraPoller). */
  NARRA_POLLER?: DurableObjectNamespace;
  /** One queue per chat room (Durable Object RoomQueue). */
  ROOM_QUEUE?: DurableObjectNamespace;
  /** Narra agent token: reads rooms and messages, and posts Penny's answers. */
  NARRA_AGENT_TOKEN?: string;
  /** Narra API base. Defaults to https://api.netmind.chat */
  NARRA_API_ENDPOINT?: string;
  /** Penny's agent id among the agents connected to this Worker (the agents table). */
  PENNY_AGENT_ID?: string;
  /** "on" also reads Narra in real time through Matrix /sync (gateway/sync.ts). */
  NARRA_SYNC?: string;
  /** The single /sync reader (Durable Object MatrixSync). */
  MATRIX_SYNC?: DurableObjectNamespace;
  /** "push": Synapse wakes MatrixSync per new event instead of a 24/7 long-poll (gateway/sync.ts).
   *  Needs NARRA_PUSH_URL and NARRA_PUSH_SECRET; anything else keeps long-polling. */
  NARRA_SYNC_MODE?: string;
  /** https origin whose root this Worker serves; the pusher URL is <origin>/_matrix/push/v1/notify. */
  NARRA_PUSH_URL?: string;
  /** Random secret (>= 16 chars); the pusher's pushkey is derived from it. */
  NARRA_PUSH_SECRET?: string;
}

/** Everything needed to talk to one agent over A2A. */
export interface AgentCredential {
  rpcUrl: string;
  token: string;
  /** Human-readable agent name, used in error messages. */
  label: string;
}

/** Errors that already know their HTTP shape. Thrown anywhere, mapped in index.ts. */
export class HttpError extends Error {
  // Plain fields rather than constructor parameter properties: keeps the class
  // friendly to any TS toolchain that only strips types.
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
