// The ledger client shared by penny.mjs and the card renderer.
// Reads the API base and key from .penny/config.json at the workspace root
// ({"apiBase": "https://...", "apiKey": "..."}) or from PENNY_API_BASE / PENNY_API_KEY.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export class LedgerError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function config() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(root, '.penny', 'config.json'), 'utf8'));
  } catch {
    // fall back to the environment
  }
  const apiBase = process.env.PENNY_API_BASE || file.apiBase;
  const apiKey = process.env.PENNY_API_KEY || file.apiKey;
  if (!apiBase || !apiKey) throw new LedgerError('not_configured', 'Missing .penny/config.json (apiBase, apiKey).');
  return { apiBase: apiBase.replace(/\/+$/, ''), apiKey };
}

export const enc = encodeURIComponent;

/** Call the ledger. Resolves to { ok, status, data } where data is the parsed JSON reply. */
export async function ledger(method, path, body) {
  const { apiBase, apiKey } = config();
  let response;
  try {
    response = await fetch(`${apiBase}/api/ledger${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new LedgerError('unreachable', `The ledger did not answer: ${error.message}`);
  }
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: { code: 'bad_response', message: text.slice(0, 200) } };
  }
  return { ok: response.ok, status: response.status, data };
}

/** Like ledger(), but throws LedgerError on an error reply. */
export async function ledgerOrThrow(method, path, body) {
  const result = await ledger(method, path, body);
  if (!result.ok) {
    const error = result.data?.error ?? {};
    throw new LedgerError(error.code ?? 'error', error.message ?? `The ledger answered ${result.status}.`, result.status);
  }
  return result.data;
}
