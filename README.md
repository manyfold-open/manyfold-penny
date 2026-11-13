# Penny

English · [中文](README_CN.md)

Penny is a corgi that keeps a group chat's shared expenses. Friends tell her what they spent
in plain language; she records it, says who owes whom, and helps the group settle up. She is
a [Manyfold](https://manyfold.ai) agent backed by a ledger on Cloudflare Workers and D1.

```
Zack   @Penny 晚餐 Dishoom 120 我付，四個人分
Penny  晚餐 Dishoom £120，Zack 付
       均分 4 人，每人 £30
       回 @Penny OK 入帳，或直接說要改什麼
Mei    @Penny OK
Penny  已入帳 #21 晚餐 Dishoom £120
Ken    @Penny 誰欠誰
Penny  Mei → Zack £175
       Ken → Zack £35
```

Penny replies in the language she is spoken to: Traditional Chinese, Simplified Chinese or
English.

## What Penny does

- **Records expenses from a sentence.** Equal splits, exact amounts, percentages, shares,
  receipts split item by item, per-person adjustments ("Ken skips the wine, take 8 off"),
  advances, refunds, and guests who are not in the chat.
- **Asks before anything counts.** Every expense, edit, deletion and repayment is a proposal
  until someone in the group says OK. A repayment can only be confirmed by the person who
  received the money.
- **Works out who owes whom.** Net balances and a settle-up plan with as few transfers as
  possible. Partial repayments are fine.
- **Answers questions about the ledger.** Recent entries, one person's paid-versus-share
  summary, and totals by category and by day.
- **Draws cards.** Anything longer than three lines goes out as a PNG drawn from live ledger
  data: who owes whom, an itemised receipt, a trip poster, spending by category, spending by
  day, and recent expenses.
- **Learns a group's habits.** "Ken never pays for drinks" is remembered per group (up to 20
  memories) and applied to later proposals, and Penny says so when it is.
- **Keeps groups apart.** One ledger per chat room. In a private chat a person can ask for
  their own position across all their groups; nobody else can.

Penny never does money arithmetic herself. Every amount, split and balance comes from the
ledger, which works in integer minor units (pence, cents, yen) and never uses floating point.

## How it is put together

```
Group chat
   │  each message wrapped with room, speaker, members and time
   ▼
Penny agent on Manyfold          agent/PENNY.md       her rules
   │                             agent/bin/penny.mjs  the ledger tool she runs
   │                             agent/cards/         the card renderer (SVG → PNG)
   │  HTTPS, Authorization: Bearer <PENNY_API_KEY>
   ▼
Cloudflare Worker (Hono)         src/worker/ledger/   /api/ledger/*
   ▼
D1                               groups, members, expenses, payers, shares,
                                 settlements, memory, payment info
```

The Worker also serves a small web app (React) for connecting Manyfold agents and chatting
with them from a browser. It comes from the
[Cloudflare Worker Starter for Manyfold Agents](https://github.com/manyfold-open/cloudflare-worker-starter)
this repository was built on, and is useful for checking that the agent answers.

| Path | Purpose |
| --- | --- |
| `agent/PENNY.md` | The agent's instructions: how to read a message, record money, settle up, reply |
| `agent/bin/penny.mjs` | Command-line ledger tool the agent runs (`node bin/penny.mjs help`) |
| `agent/bin/ledger.mjs` | The HTTP client shared by the tool and the card renderer |
| `agent/cards/` | Six cards in three languages, drawn as SVG and rendered to PNG with resvg |
| `src/worker/ledger/routes.ts` | The ledger API and its bearer-key check |
| `src/worker/ledger/store.ts` | Proposals, confirmations, versions, balances, stats |
| `src/worker/ledger/money.ts` | Split and settle-up arithmetic: pure functions, integers only |
| `src/worker/ledger/schema.ts` | The ledger tables |
| `src/worker/` (the rest) | The starter's Manyfold connect flow, chat and credential encryption |
| `src/app/` | The starter's web app |
| `tests/` | Unit tests (vitest), including the ledger and the money arithmetic |

### The ledger

- **Append-only.** An edit or a deletion adds a new version of the entry; it replaces the
  old one only once someone confirms it. `entry <room> <seq>` shows every version.
- **Proposed, then confirmed.** Entries start as `pending`. Nothing pending affects a
  balance.
- **Group-scoped.** Every query names its group id, which is the chat platform's room id.
- **Off by default.** `/api/ledger/*` answers 503 until the `PENNY_API_KEY` secret is set, so
  a fresh deploy never exposes an open ledger.

The full route list is at the top of
[`src/worker/ledger/routes.ts`](src/worker/ledger/routes.ts).

## Running your own Penny

### 1. Deploy the ledger

Every push to `main` is checked and deployed by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). In a fork:

1. Create the database with `npx wrangler d1 create manyfold-penny-db` and put the returned
   `database_id` in `wrangler.jsonc`.
2. Add the `CLOUDFLARE_API_TOKEN` secret and the `CLOUDFLARE_ACCOUNT_ID` variable to the
   GitHub repository. Set the `PRODUCTION_URL` variable to your Worker's URL so the
   post-deploy health check looks in the right place.
3. Set the ledger key. Use a long random value; the agent needs the same one.

   ```bash
   npx wrangler secret put PENNY_API_KEY
   ```

4. Recommended: lock the web app, and keep the encryption key out of the database (see
   [Security notes](#security-notes)).

   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   ```

   ```bash
   npx wrangler secret put CONFIG_ENCRYPTION_KEY
   ```

The schema is applied at runtime, so there is no migration step.

### 2. Set up the agent

The contents of `agent/` go into a Manyfold agent's workspace, with `PENNY.md` as its
instructions. The workspace also needs a `.penny/config.json`, which is git-ignored and
uploaded separately:

```json
{ "apiBase": "https://<your-worker>.workers.dev", "apiKey": "<PENNY_API_KEY>" }
```

`PENNY_API_BASE` and `PENNY_API_KEY` in the environment work too. In the workspace, install
the card renderer's one dependency and fetch its fonts (Noto Sans TC and SC) once:

```bash
npm install && npm run setup
```

After changing the rules or the tool, upload them again with the Manyfold CLI:

```bash
mf files upload agent/PENNY.md PENNY.md --agent-id <id>
```

### 3. Send her messages

Penny expects every message wrapped in a header that says which room it came from, who is
speaking and who is in the chat:

```
<penny-message>
room: !london:example
room_name: 倫敦四日
chat: group
from: @zack:example (Zack)
members: @zack:example (Zack); @mei:example (Mei); @ken:example (Ken); @ray:example (Ray)
time: 2026-11-08T19:42:00Z
---
@Penny 晚餐 Dishoom 120 我付，四個人分
</penny-message>
```

`room` selects the ledger, so whatever bridges your chat platform to the agent must set it
and must not let message text override it.

### 4. Optional: put the gateway in front of Penny

Connected straight to a Manyfold Matrix channel, Penny gets every message in the group, all
in one long session. The gateway in `src/worker/gateway/` puts this Worker in between:

```
NarraPoller (Durable Object) reads new messages through Narra's agent-runtime chat API
   → filter → one queue per room (RoomQueue, Durable Object)
   → Penny turn in a fresh context (A2A) → answer posted into the room through Narra
```

- **It reads, rather than waits for a webhook.** Narra only offers webhooks to agents that
  chose them when first bound, and only for @mentions. The poller reads one room per tick,
  every 8 s for rooms with recent activity and every 20 s for quiet ones. That stays within
  Narra's 30 reads a minute per agent token, which Penny's own history reads share.
- **The filter** drops chatter for free. Penny is called only for mentions, for answers to her
  proposals ("OK #21"), and for messages where someone says they spent or repaid money.
- **One queue per room**: a group's messages are handled in order, while different groups
  run in parallel. Failed turns are retried, and the same message is never answered twice.
- **A fresh context for every message**, so no session grows and no group sees another's.
- **Replies and 👍 count.** Replying to one of Penny's messages, or putting 👍 / 👌 / ✅ on
  it, reaches her with the message it answers, so "OK" on a proposal needs no @mention. The
  poller remembers her last 30 messages per room to tell.
- **No waiting in silence.** When someone talks to Penny directly, the gateway posts
  "🐶 我看一下帳本…" as soon as her turn starts and edits that message into her answer when
  it is ready (Narra's `messages/patch`). If she ends up saying nothing, the note is deleted;
  if her turn fails for good, it says so.
- **No noise.** An empty answer (or a placeholder like "(empty response)") is never posted.
- **Capacity.** One read every 4 s is shared by every room, so a quiet room waits about
  `max(20 s, rooms × 4 s)`. `npm run simulate` runs the real poller against 5 to 200 simulated
  rooms and prints the waits; `GET /api/gateway/status` shows the live ones (read delay, queue
  wait, Penny's turn, time to answer, as p50/p95/max seconds).
- **Encrypted rooms are skipped.** Narra does not let agents into end-to-end encrypted chats,
  so a bookkeeping group must be a normal (unencrypted) chat.

To switch it on:

1. Connect Penny in this Worker's web app.
2. Set the `PENNY_AGENT_ID` var to her agent id.
3. Set the `NARRA_AGENT_TOKEN` secret.
4. Set the `NARRA_GATEWAY` var to `poll`.
5. Disconnect the Manyfold Matrix channel from those rooms, or Penny answers twice.

The cron trigger starts the poller within five minutes. Penny answers new messages from then
on; earlier ones stay in the room's history.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then set PENNY_API_KEY and anything else you need
npm run dev
```

One command runs the web app with HMR and the Worker in workerd with a local D1 database.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server (app + worker + local D1) |
| `npm run check` | Typecheck, build, `wrangler deploy --dry-run` |
| `npm test` | Unit tests (vitest) |
| `npm run deploy` | Manual deploy (GitHub Actions normally does this) |
| `npm run smoke -- <url>` | Smoke-test a deployment |

To work on the cards without a ledger, render all six in every language from built-in sample
data. The PNGs land in `agent/out/demo/<lang>/`:

```bash
cd agent && npm install && npm run demo
```

To drive the ledger by hand, point the tool at your dev server:

```bash
PENNY_API_BASE=http://localhost:5173 PENNY_API_KEY=<key> node agent/bin/penny.mjs help
```

[`AGENTS.md`](AGENTS.md) lists the invariants to preserve while changing this codebase.

## Security notes

- **The ledger is reachable only with `PENNY_API_KEY`**, compared in constant time. It is
  called by the agent, not a browser, so it skips the Origin check and the admin password.
  Anyone holding the key can read and write every group's ledger: keep it in the agent's
  workspace config and in a Worker secret, nowhere else.
- **The agent is told never to reveal the key** or the contents of `.penny/config.json`, and
  to take the room id only from the message header, never from message text.
- **Payment details are encrypted at rest** (AES-GCM) and shown only to someone who is paying
  that person.
- **The web app is open by default.** Anyone with the URL can connect agents and chat until
  you set `ADMIN_PASSWORD`.
- **Agent tokens for the web app are AES-GCM encrypted in D1** with a key derived from
  `CONFIG_ENCRYPTION_KEY`, or from a random key generated on first use and stored in the same
  database. A generated key protects against partial exposure but not a full database dump;
  set the secret to remove that caveat.

## License

[MIT](LICENSE)
