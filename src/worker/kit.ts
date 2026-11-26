/**
 * Penny on narra-agent-kit's chat-native (v2) pipeline, for the rooms in NARRA_PIPELINE_ROOMS only.
 * Penny's own gateway (src/worker/gateway) keeps every other room; gateway/handoff.ts decides which
 * gateway owns a room, and the kit runs with NARRA_PIPELINE_ONLY_LISTED=on so it leaves the rest alone.
 *
 * The kit is Penny's ears and hands: it decides cheaply whether Penny's Manyfold brain should look
 * at a message (DMs, @mentions, replies, 👍 on her proposals, embedding relevance, and `wakeHint`
 * below), claims it with 👀 so other agents step back, and posts what the brain writes. The brain
 * (agent/PENNY.md + the ledger tool) still decides what is recorded and said.
 *
 * What PENNY.md reads from a gateway message and the kit does not give is added in
 * `pennyEnvelopeFields`: the gateway verdict, the actor token that proves who is speaking, the
 * message of Penny's that was replied or reacted to, and, for scheduled turns only, the nudge kind.
 */

import {
  detectLang,
  isAimedElsewhere,
  isSelfMentioned,
  type AgentSpec,
  type HistoryTurn,
  type InboundEvent,
  type LangCode,
  type RoomContext,
  type TriageDecision,
} from '@manyfold/narra-agent-kit';
import {
  createNarraWorkerGateway,
  handleNarraPushRequest,
  NARRA_PUSH_NOTIFY_PATH,
  type NarraGatewayConfig,
  type V2ProactiveItem,
} from '@manyfold/narra-agent-kit/worker';
import type { Env } from './types';
import { credentialFor } from './connect';
import { actorToken } from './ledger/actor';
import { dailyFromLedger } from './gateway/daily';
import { kitRoomIds } from './gateway/handoff';
import { handlePushRequest } from './gateway/sync';

export const PENNY_MATRIX_ID = '@agent-54ebea3a:matrix.netmind.chat';

export const PENNY_SPEC: AgentSpec = {
  id: 'penny',
  matrixId: PENNY_MATRIX_ID,
  name: 'Penny',
  aliases: ['Penny'],
  domainDescription:
    "Keeps a group's shared expenses: records who paid what and how it is split, works out who owes whom, helps the group settle up, and reads receipts.",
};

/* ───────── amounts (structural, no phrase lists) ───────── */

const CODES = 'gbp|usd|eur|jpy|twd|ntd|hkd|cny|rmb|aud|cad|sgd|chf|krw';
const UNITS = `元|塊|块|镑|鎊|英鎊|英镑|刀|円|圓|pounds?\\b|quid\\b|bucks?\\b|dollars?\\b|euros?\\b|(?:${CODES})\\b`;
const AMOUNT_PATTERNS = [
  // £30, $ 12.50, €8
  /[£$€¥]\s*\d/,
  // GBP 30, rmb200
  new RegExp(`\\b(?:${CODES})\\s*\\d`, 'i'),
  // 30元, 25 pounds, 12.5 quid, 30 gbp, 1.2k 塊
  new RegExp(`\\d(?:[.,]\\d+)?\\s*k?\\s*(?:${UNITS})`, 'i'),
  // Chinese numerals with a unit: 三百塊, 五十元, 兩百五十鎊
  /[一二三四五六七八九十百千萬万兩两零]+\s*(?:元|塊|块|镑|鎊|英鎊|英镑|刀)/,
];

/** A number with a currency or money unit next to it. Whether it is a spend is the brain's call. */
export function hasAmount(text: string): boolean {
  return AMOUNT_PATTERNS.some((re) => re.test(text ?? ''));
}

/** Short enough to be an answer to a proposal ("好", "OK", "#21", "OK #21 #22", "取消 #3"). */
export function isShortAnswer(text: string): boolean {
  const t = (text ?? '').replace(/@\S+/g, '').trim();
  if (!t || /https?:\/\//i.test(t)) return false;
  const length = [...t].length;
  return length <= 12 || (/#\d+/.test(t) && length <= 24);
}

/* ───────── ledger reads ───────── */

/**
 * Whether `memberId` could OK something waiting in this group, by the ledger's own confirm rules
 * (store.ts checkConfirmer): never the proposer; someone on the entry if anyone else is; the
 * receiver of a repayment. Only they can answer a proposal with a short "OK".
 */
export async function canConfirmPending(env: Env, roomId: string, memberId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS p FROM ledger_expenses e
     WHERE e.group_id = ?1 AND e.status = 'pending' AND e.created_by != ?2
       AND (
         EXISTS (SELECT 1 FROM ledger_payers p WHERE p.expense_id IN (e.id, e.replaces_id) AND p.member_id = ?2)
         OR EXISTS (SELECT 1 FROM ledger_shares s WHERE s.expense_id IN (e.id, e.replaces_id) AND s.member_id = ?2)
         OR NOT EXISTS (
           SELECT 1 FROM ledger_payers p WHERE p.expense_id IN (e.id, e.replaces_id) AND p.member_id != e.created_by
           UNION ALL
           SELECT 1 FROM ledger_shares s WHERE s.expense_id IN (e.id, e.replaces_id) AND s.member_id != e.created_by
         )
       )
     UNION ALL
     SELECT 1 FROM ledger_settlements WHERE group_id = ?1 AND status = 'pending' AND to_member = ?2
     LIMIT 1`,
  )
    .bind(roomId, memberId)
    .first<{ p: number }>();
  return Boolean(row);
}

export async function hasPending(env: Env, roomId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS p FROM ledger_expenses WHERE group_id = ? AND status = 'pending' UNION ALL SELECT 1 FROM ledger_settlements WHERE group_id = ? AND status = 'pending' LIMIT 1",
  )
    .bind(roomId, roomId)
    .first<{ p: number }>();
  return Boolean(row);
}

async function knownGroup(env: Env, roomId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare('SELECT 1 AS g FROM ledger_groups WHERE id = ?').bind(roomId).first());
}

/* ───────── wake hint ───────── */

/** Addressed turns are the kit's: a 'wake' here would turn them into unaddressed ones. */
function addressed(event: InboundEvent, context: RoomContext): boolean {
  return context.chatType === 'dm' || isSelfMentioned(event, PENNY_SPEC) || Boolean(context.replyToTarget?.isSelf);
}

/**
 * From Penny's own state, not phrase lists: wake for an amount (a number with a currency or unit),
 * a photo with a caption (it may be a receipt), or a short answer from someone a waiting proposal
 * needs an OK from. Everything else is left to the kit (mentions, replies, relevance).
 */
export async function pennyWakeHint(env: Env, event: InboundEvent, context: RoomContext): Promise<'wake' | null> {
  if (addressed(event, context) || isAimedElsewhere(event, context, PENNY_SPEC)) return null;
  const text = event.text ?? '';
  if (hasAmount(text)) return 'wake';
  if (event.kind === 'image' || event.kind === 'compound') return 'wake';
  // Only someone who can OK a waiting proposal: everyone else's short messages are not for Penny.
  if (isShortAnswer(text) && event.senderId && (await canConfirmPending(env, event.roomId, event.senderId).catch(() => false))) {
    return 'wake';
  }
  return null;
}

/* ───────── envelope ───────── */

type Verdict = 'called' | 'expense' | 'photo' | 'question' | 'nudge';
type NudgeKind = 'daily' | 'welcome';

/**
 * A scheduled turn the kit started from `pennyProactive`. Only the kit makes these: their event id
 * is `proactive:<key>` (a person's message has a `$…` id), they have no sender, and the kit marks
 * them `v2_proactive`. Nothing a person types can produce one.
 */
export function proactiveKind(event: InboundEvent, decision: Pick<TriageDecision, 'reason'>): NudgeKind | null {
  if (decision.reason !== 'v2_proactive' || event.senderId || !event.eventId.startsWith('proactive:')) return null;
  const kind = event.eventId.slice('proactive:'.length).split(':')[0];
  return kind === 'daily' || kind === 'welcome' ? kind : null;
}

const DIRECT_REASONS = new Set(['dm', 'explicit_mention', 'reply_to_self']);

/** The old gateway's verdict, from the wake reason and the message alone. */
export function verdictFor(event: InboundEvent, decision: Pick<TriageDecision, 'reason'>, context: RoomContext): Verdict {
  if (proactiveKind(event, decision)) return 'nudge';
  if (event.kind === 'reaction') return 'called';
  if (DIRECT_REASONS.has(decision.reason) || context.chatType === 'dm') return 'called';
  if (event.kind === 'image' || event.kind === 'compound') return 'photo';
  if (hasAmount(event.text ?? '')) return 'expense';
  // Woken by the hint without an amount: a short answer while a proposal waits for its OK.
  if (decision.reason === 'v2_agent_hint') return 'called';
  // Woken by relevance ("誰欠誰", "settle up"): answer from the ledger, or stay silent.
  return 'question';
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

/** What PENNY.md expects in a gateway message and the kit's envelope does not carry. v2 turns only. */
export async function pennyEnvelopeFields(
  env: Env,
  event: InboundEvent,
  decision: TriageDecision,
  context: RoomContext,
  info?: { pipeline: 'v1' | 'v2' },
): Promise<Record<string, string> | undefined> {
  if (info?.pipeline !== 'v2') return undefined;
  const nudge = proactiveKind(event, decision);
  const fields: Record<string, string> = { gateway_verdict: verdictFor(event, decision, context) };
  if (nudge) {
    fields.nudge = nudge;
    return fields;
  }
  const target = context.replyToTarget;
  if (target?.isSelf) {
    const quoted = `"${oneLine(target.text).slice(0, 500)}"`;
    if (event.kind === 'reaction') fields.reacted_to_penny = quoted;
    else fields.in_reply_to_penny = quoted;
  }
  // Signed for this room and this sender: the ledger's proof of who is speaking (ledger/actor.ts).
  if (event.senderId) fields.actor_token = await actorToken(env, event.roomId, event.senderId);
  // In kit rooms Penny also handles group messages that do not @ her (Narra agreed, 2026-11-26).
  // PENNY.md step 1 then runs authorize with --allow-unmentioned, which accepts only the
  // `not_mentioned` denial; every other check still applies. Set only by this gateway.
  if (context.chatType === 'group' && event.senderId) fields.unaddressed_ok = 'true';
  return fields;
}

/* ───────── scheduled turns: evening recap, welcome ───────── */

const LANG_MARK: Record<LangCode, string> = {
  'zh-Hant': '（群組語言：繁體中文）',
  'zh-Hans': '（群组语言：简体中文）',
  en: '(group language: English)',
};

/**
 * The group's language for a scheduled turn. The kit writes a scheduled post in the language of
 * its note, so the note carries the group's language: the one the group set (`remember <room>
 * language`), else the most common one in recent messages, else Traditional Chinese.
 */
async function groupLang(env: Env, roomId: string): Promise<LangCode> {
  const row = await env.DB.prepare("SELECT value FROM ledger_memory WHERE group_id = ? AND key = 'language'")
    .bind(roomId)
    .first<{ value: string }>()
    .catch(() => null);
  const set = row?.value?.trim();
  if (set === 'zh-Hant' || set === 'zh-Hans' || set === 'en') return set;
  if (env.NARRA_ROOM_DO) {
    try {
      const res = await env.NARRA_ROOM_DO.get(env.NARRA_ROOM_DO.idFromName(roomId)).fetch('https://narra-room/history');
      const body = (await res.json().catch(() => null)) as { history?: HistoryTurn[] } | null;
      const counts: Record<LangCode, number> = { 'zh-Hant': 0, 'zh-Hans': 0, en: 0 };
      for (const turn of (body?.history ?? []).filter((t) => !t.isAgent && t.text?.trim()).slice(-20)) counts[detectLang(turn.text)]++;
      const best = (Object.keys(counts) as LangCode[]).sort((a, b) => counts[b] - counts[a])[0];
      if (counts[best] > 0) return best;
    } catch {
      // Fall through to the default.
    }
  }
  return 'zh-Hant';
}

export function nudgeNote(kind: NudgeKind, lang: LangCode, about?: string): string {
  return `[penny nudge] ${kind}${about ? ` ${about}` : ''} ${LANG_MARK[lang]}`;
}

interface RoomInfo {
  listed: boolean;
  type: 'group' | 'dm' | null;
  started: boolean;
  welcomed: boolean;
}

/** What Penny's own gateway knows about a room: if it ever read or welcomed it, it is not new. */
async function oldGatewayRoom(env: Env, roomId: string): Promise<RoomInfo | null> {
  if (!env.NARRA_POLLER) return null;
  try {
    const res = await env.NARRA_POLLER.get(env.NARRA_POLLER.idFromName('narra')).fetch(
      `https://narra-poller/room-info?room=${encodeURIComponent(roomId)}`,
    );
    return res.ok ? ((await res.json()) as RoomInfo) : null;
  } catch {
    return null;
  }
}

/**
 * Asked by the kit on every cron kick (v2 rooms only; it dedupes by key and applies the room's
 * posting manners). The evening recap goes to groups that recorded something today, at 21:00 in
 * the group's own time zone, and also lists entries still waiting for an OK (there are no daytime
 * reminders in v2 rooms). A welcome goes to a group Penny was just added to and has no ledger yet.
 */
export async function pennyProactive(env: Env, nowMs: number): Promise<V2ProactiveItem[]> {
  const rooms = kitRoomIds(env);
  if (rooms.length === 0) return [];
  const items: V2ProactiveItem[] = [];
  for (const { roomId, date } of await dailyFromLedger(env, nowMs)) {
    if (!rooms.includes(roomId)) continue;
    items.push({
      roomId,
      key: `daily:${date}`,
      note: nudgeNote('daily', await groupLang(env, roomId), date),
      // 21:00 in the group's zone is past the kit's default 21:00 end of the posting day.
      rules: { endHour: 23 },
    });
  }
  for (const roomId of rooms) {
    const old = await oldGatewayRoom(env, roomId);
    // Only a group (per Narra's room list) that Penny's own gateway never read or welcomed.
    if (!old || old.type !== 'group' || old.started || old.welcomed) continue;
    if (await knownGroup(env, roomId)) continue;
    items.push({ roomId, key: 'welcome', note: nudgeNote('welcome', await groupLang(env, roomId)), ignoreRoomRules: true });
  }
  return items;
}

/* ───────── config ───────── */

export const pennyKitConfig: NarraGatewayConfig<Env> = {
  spec: PENNY_SPEC,
  resolveA2ACredential: async (env) => {
    const agentId = (env.PENNY_AGENT_ID ?? '').trim();
    if (!agentId) return null;
    const cred = await credentialFor(env, agentId);
    return { url: cred.rpcUrl, token: cred.token, label: cred.label };
  },
  buildExtraEnvelopeFields: (env, event, decision, _memories, context, info) =>
    pennyEnvelopeFields(env, event, decision, context, info),
  v2: {
    profile:
      "Penny the corgi keeps a group's shared expenses. She records who paid for what and how it is split, " +
      'works out who owes whom and how much, helps the group settle up with the fewest transfers, ' +
      'confirms entries when people OK them, and reads receipts and bills from photos.',
    wakeExamples: [
      'Boots 15',
      '我付了午餐 £30',
      '晚餐 120 我付的，大家平分',
      '计程车 25 镑我出的',
      'I paid £42 for the groceries, split it four ways',
      '誰欠誰',
      '我还欠你多少钱',
      'settle up',
      'How much do I owe Mei?',
      '收據',
      '這張發票幫我記一下',
      'Can you split this bill between us?',
    ],
    notExamples: [
      'Any AI news today?',
      '今天有什麼 AI 新聞？',
      '這週末倫敦有什麼快閃活動？',
      'Any pop-ups or events in London this weekend?',
      '晚餐吃啥好，推薦一家餐廳',
      '幫我抽一張塔羅牌',
      '幫我求一支籤',
      '這週末倫敦有什麼 AI 黑客松或資料集？',
    ],
    // PENNY.md: a 👍 (👌, ✅) on a proposal confirms it.
    reactionsToSelf: ['👍', '👌', '✅'],
    // PENNY.md: every gateway message is a fresh conversation; the ledger is the memory.
    freshContext: true,
    wakeHint: pennyWakeHint,
    proactive: pennyProactive,
  },
};

export const pennyKit = createNarraWorkerGateway(pennyKitConfig);

/**
 * Synapse calls one path, /_matrix/push/v1/notify, for both pushers on Penny's account: Penny's own
 * (app_id ai.manyfold.penny, pushkey "penny:…") and the kit's (app_id nexus.narra.agent-kit,
 * pushkey "nak:…"). Each handler answers a pushkey it does not know with `rejected`, which makes
 * Synapse delete that pusher, so each notification goes only to the handler that owns its pushkey.
 */
export async function routePush(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== NARRA_PUSH_NOTIFY_PATH || request.method !== 'POST') {
    return handlePushRequest(request, env);
  }
  const body = await request.text();
  let kit = false;
  try {
    const devices = (JSON.parse(body) as { notification?: { devices?: unknown } } | null)?.notification?.devices;
    kit = Array.isArray(devices) && devices.some((d) => typeof (d as { pushkey?: unknown })?.pushkey === 'string' && (d as { pushkey: string }).pushkey.startsWith('nak:'));
  } catch {
    kit = false;
  }
  const copy = new Request(request.url, { method: 'POST', headers: request.headers, body });
  return kit ? handleNarraPushRequest(copy, env) : handlePushRequest(copy, env);
}
