# Working on this repository

Rules for anyone — human or AI agent — iterating on an app built from this template.
The template is designed to be extended and reshaped; these are the load-bearing walls.

## How deployment works

- **GitHub Actions is the deploy path.** Every push to `main` runs `.github/workflows/deploy.yml`:
  `npm run check`, `npm test`, then `npx wrangler deploy` with the repo's `CLOUDFLARE_API_TOKEN`
  secret, then copies the `NARRA_AGENT_TOKEN` repo secret (if set) into the Worker's secret of
  that name, then a wait on `GET /api/health`. Pull requests only run checks
  (`.github/workflows/ci.yml`), which hold no credentials.
- The build step is load-bearing: `wrangler deploy` deploys the output that
  `vite build` writes to `dist/` (via the Cloudflare Vite plugin's deploy-config redirect).
  Never deploy without building first, and never remove the `build` script.
- After every push, verify the deployment: `GET /api/health` must return HTTP 200 JSON, or
  run `npm run smoke -- <url>`.

## Invariants

1. **Keep `wrangler.jsonc` deployable.** `main`, `assets`, and the `DB` binding are read by
   the app. Never edit `database_id` — the Deploy button wrote the real one and changing it
   orphans the user's data.
2. **Keep `GET /api/health` returning 200 JSON.** It is the deploy-verification contract for
   smoke tests and for the deploy workflow's final check.
3. **Evolve the database only through `SCHEMA` in `src/worker/db.ts`**, with
   `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`. Keep semicolons out of
   statement bodies (the splitter treats every `;` as a boundary). There is no migration
   step, and nothing may assume one.
4. **Never commit secrets.** New secrets get a commented entry in `.dev.vars.example` and an
   instruction to run `npx wrangler secret put NAME`. `.dev.vars` is git-ignored; keep it so.
5. **Respect the runtime split.** `src/worker/` runs in workerd only (no Node-built-ins),
   `src/app/` runs in the browser only, `src/shared/` must run in both.
6. **Preserve the credential-security invariants:**
   - the Manyfold device code and agent bearer tokens never appear in an API response, a log
     line, or the browser — they are AES-GCM sealed in D1 (`seal`/`unseal` in
     `src/worker/crypto.ts`);
   - connectivity checks use the non-billing `tasks/get` probe
     (`probeAgentAuth`), never `message/send` — a real turn bills the user;
   - agent-supplied URLs go through `validateA2AUrl` before use (SSRF guard);
   - error strings pass through `safeErrorText` before leaving the worker;
   - Penny's Matrix login (fetched with her Narra bearer, `src/worker/gateway/sync.ts`) lives
     only in the `MatrixSync` object's memory: never stored, logged or returned, and sent only to
     an https `*.netmind.chat` homeserver. Everything else that acts as Penny on Matrix (sends,
     edits, typing, read receipts) asks `MatrixSync` to do it (`POST /matrix`);
   - the rooms in `NARRA_PIPELINE_ROOMS` ("zack test") are served by narra-agent-kit's v2 pipeline
     instead (`src/worker/kit.ts`): its `NarraMatrixSync` holds its own copy of the login the same
     way. Penny's gateway skips those rooms (`gateway/handoff.ts`) and the kit ignores every other
     one (`NARRA_PIPELINE_ONLY_LISTED=on`), so each room has exactly one gateway. Both pushers share
     `/_matrix/push/v1/notify` and are told apart by pushkey (`routePush`); never let one handler
     answer the other's pushkey, or Synapse deletes that pusher;
   - A2A `messageId`s are derived from stored rows, not random, so retries cannot
     double-bill (`src/worker/chat.ts`).
   - in a room on a real homeserver, every ledger change (`add`, `edit`, `delete`, `settle`,
     `confirm`, `cancel`) needs the `actor_token` the gateway signs for that message's room and
     sender (`src/worker/ledger/actor.ts`); `--by` must be that sender. The model's word for who
     spoke is never enough. The gateway quotes header-shaped lines in a message body
     (`defuse` in `src/worker/gateway/envelope.ts`) so nobody can type a second context block.
     Deploy order: upload `agent/bin/penny.mjs` and `agent/PENNY.md` before the worker, or
     Penny's changes in real rooms are refused until you do.
7. **Keep new routes behind the admin gate.** Any route added under `/api/` is protected by
   the `ADMIN_PASSWORD` middleware automatically — do not add exceptions beyond `/api/health`
   and `/api/state` without a reason as good as theirs. The one exception is `/api/ledger/*`:
   the Penny agent calls it, not a browser, so it skips the Origin check and the admin password
   and requires `Authorization: Bearer <PENNY_API_KEY>` instead (`src/worker/ledger/routes.ts`).
   Without that secret the ledger answers 503, never an open ledger. `GET /share/<token>` sits
   outside `/api/` and shows one group's ledger read-only: the token is a random link id plus
   its HMAC (`sign` in `src/worker/crypto.ts`), Penny makes and rotates it through
   `/api/ledger/groups/:g/share`, and a revoked or forged token gets a 404 (`src/worker/ledger/share.ts`).
8. **The ledger is append-only and group-scoped.** Every ledger query names its group id.
   Money changes are proposed, then confirmed; edits and deletions add a version and never
   overwrite one. Amounts are integer minor units, split only through `ledger/money.ts`.

## Penny, the agent

`agent/` holds what goes into the Manyfold agent's workspace: `PENNY.md` (its rules) and
`bin/penny.mjs` (the ledger tool). The tool reads `.penny/config.json` (`apiBase`, `apiKey`),
which is git-ignored and uploaded to the workspace separately. Update the agent with
`mf files upload agent/PENNY.md PENNY.md --agent-id <id>` and the same for `bin/penny.mjs`.

## Checks

Before pushing:

```bash
npm run check   # typecheck + build + wrangler deploy --dry-run
npm test        # vitest unit tests
```

After a deploy:

```bash
npm run smoke -- https://your-app.workers.dev
```

## What is safe to change

Everything else. The chat UI, the styles, the page structure, extra tables, extra routes,
extra pages — the template exists to be rebuilt into your app. Deleting the chat or settings
pages is fine once you no longer need them; keep the connect flow (`src/worker/connect.ts`,
`src/worker/a2a.ts`, `src/worker/crypto.ts`) if your app talks to Manyfold agents at all.
