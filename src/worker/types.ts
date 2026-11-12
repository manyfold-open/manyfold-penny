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
  /** Optional: >=32 chars. Without it a key is generated and kept in D1. */
  CONFIG_ENCRYPTION_KEY?: string;
  /** Optional: when set, all routes except /api/health and /api/state require x-admin-password. */
  ADMIN_PASSWORD?: string;
  /** Bearer key the Penny agent presents to /api/ledger/*. The ledger is off without it. */
  PENNY_API_KEY?: string;

  /* The Narra gateway (src/worker/gateway). Off until NARRA_WEBHOOK_SECRET is set. */
  /** One queue per chat room (Durable Object RoomQueue). */
  ROOM_QUEUE?: DurableObjectNamespace;
  /** Bearer secret Narra presents to POST /api/narra/events. */
  NARRA_WEBHOOK_SECRET?: string;
  /** Narra agent token, used to post Penny's answers into rooms. */
  NARRA_AGENT_TOKEN?: string;
  /** Narra API base. Defaults to https://api.netmind.chat */
  NARRA_API_ENDPOINT?: string;
  /** Penny's agent id among the agents connected to this Worker (the agents table). */
  PENNY_AGENT_ID?: string;
  /** Penny's Matrix user id, to spot mentions and skip her own messages. */
  PENNY_MATRIX_ID?: string;
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
