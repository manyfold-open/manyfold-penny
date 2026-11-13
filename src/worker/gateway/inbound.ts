/**
 * One Narra message, normalised. The poller builds it from a Matrix room event as Narra's
 * chat API returns it:
 *
 *   { event: { room_id, event_id, sender, origin_server_ts, type: "m.room.message",
 *              content: { msgtype, body, "m.mentions": { user_ids } } },
 *     room_name, chat_type ("group" | "dm"), sender_name }
 *
 * Text messages and photos (m.image) come through; other events (joins, reactions, files,
 * encrypted events) give null.
 */

export interface InboundMessage {
  roomId: string;
  roomName: string;
  chatType: 'group' | 'dm';
  eventId: string;
  senderId: string;
  senderName: string;
  text: string;
  /** ISO time the message was sent. */
  time: string;
  /** Matrix user ids the client marked as mentioned (m.mentions), if any. */
  mentions: string[];
  /** 'image' for a photo, whose text is its caption or file name. Absent for text, so queue
   *  items written before photos came through still read as text. */
  kind?: 'image';
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

export class InboundError extends Error {}

const MAX_TEXT = 16_000;

export function parseInbound(raw: unknown): InboundMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InboundError('The body must be a JSON object.');
  const outer = raw as Record<string, unknown>;
  const event = (outer.event && typeof outer.event === 'object' ? outer.event : outer) as Record<string, unknown>;
  const content = (event.content && typeof event.content === 'object' ? event.content : {}) as Record<string, unknown>;

  // Matrix events that are not messages (joins, reactions, typing) are fine to receive and ignore.
  const type = str(event.type);
  if (type && type !== 'm.room.message') return null;
  const msgtype = str(content.msgtype);
  if (msgtype && msgtype !== 'm.text' && msgtype !== 'm.notice' && msgtype !== 'm.image') return null;
  const image = msgtype === 'm.image';

  const roomId = str(pick(event, 'room_id', 'roomId') ?? pick(outer, 'room_id', 'roomId'));
  const eventId = str(pick(event, 'event_id', 'eventId', 'message_id', 'messageId'));
  const senderId = str(pick(event, 'sender', 'sender_id', 'senderId'));
  const text = str(pick(content, 'body') ?? pick(event, 'text', 'body'));
  if (!roomId.startsWith('!') || !eventId || !senderId.startsWith('@')) {
    throw new InboundError('A message needs room_id (!…), event_id and sender (@…).');
  }
  if (!text.trim() && !image) return null;

  const ts = pick(event, 'origin_server_ts', 'time', 'sent_at', 'received_at');
  const time =
    typeof ts === 'number' ? new Date(ts).toISOString() : str(ts) && !Number.isNaN(Date.parse(str(ts))) ? new Date(str(ts)).toISOString() : new Date().toISOString();

  const declared = str(pick(outer, 'chat_type', 'chatType') ?? pick(event, 'chat_type', 'chatType'));
  const mentionsRaw = (content['m.mentions'] as Record<string, unknown> | undefined)?.user_ids ?? pick(event, 'mentions');
  const mentions = Array.isArray(mentionsRaw) ? mentionsRaw.filter((m): m is string => typeof m === 'string') : [];

  return {
    roomId,
    roomName: str(pick(outer, 'room_name', 'roomName') ?? pick(event, 'room_name', 'roomName')).slice(0, 200),
    chatType: declared === 'dm' ? 'dm' : 'group',
    eventId,
    senderId,
    senderName: str(pick(outer, 'sender_name', 'senderName') ?? pick(event, 'sender_name', 'senderName')).slice(0, 200),
    text: text.slice(0, MAX_TEXT),
    time,
    mentions,
    ...(image ? { kind: 'image' as const } : {}),
  };
}
