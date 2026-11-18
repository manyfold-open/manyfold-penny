/**
 * Penny's mention markup, turned into a real Narra @mention.
 *
 * Penny writes a person who has to act as `[@Ken](@sp-abc:matrix.netmind.chat)` (agent/PENNY.md).
 * Sent through Matrix, that becomes what Narra Messenger's own composer sends for a mention
 * (hybrid-im-knowledge, message-lifecycle-flow.md): "@Ken" in the body, a matrix.to pill in
 * formatted_body, and the id in m.mentions, which is what triggers the push. Sent through the
 * chat API, which takes plain text only, it is just "@Ken".
 *
 * Never a mention of Penny herself or of another Narra agent: an agent message that mentions
 * another agent wakes it, and Narra refuses the 4th such message in a row.
 */

import { isNarraAgent } from './filter';

const TOKEN = /\[@([^\]\n]{1,60})\]\((@[A-Za-z0-9._=\-/+]+:[A-Za-z0-9.-]+(?::\d{1,5})?)\)/g;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface Rendered {
  body: string;
  /** org.matrix.custom.html, or null when there is no mention to show. */
  html: string | null;
  userIds: string[];
}

export function renderMentions(text: string, pennyId = ''): Rendered {
  const userIds: string[] = [];
  let body = '';
  let html = '';
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const [whole, rawName, userId] = match;
    const name = rawName.trim().replace(/^@/, '');
    const before = text.slice(last, match.index);
    body += before;
    html += escapeHtml(before);
    if (userId === pennyId || isNarraAgent(userId)) {
      body += name;
      html += escapeHtml(name);
    } else {
      body += `@${name}`;
      html += `<a href="https://matrix.to/#/${escapeHtml(userId)}">@${escapeHtml(name)}</a>`;
      if (!userIds.includes(userId)) userIds.push(userId);
    }
    last = (match.index ?? 0) + whole.length;
  }
  body += text.slice(last);
  html += escapeHtml(text.slice(last));
  return { body, html: userIds.length ? html.replace(/\n/g, '<br>') : null, userIds };
}

/** The same text for the chat API, which only takes plain text. */
export const plainMentions = (text: string, pennyId = '') => renderMentions(text, pennyId).body;

/** Matrix content for a new message, optionally a reply. */
export function messageContent(text: string, pennyId: string, replyTo?: string): Record<string, unknown> {
  const r = renderMentions(text, pennyId);
  return {
    msgtype: 'm.text',
    body: r.body,
    ...(r.html ? { format: 'org.matrix.custom.html', formatted_body: r.html } : {}),
    // Always present: an empty m.mentions tells clients not to guess mentions from the text.
    'm.mentions': r.userIds.length ? { user_ids: r.userIds } : {},
    ...(replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyTo } } } : {}),
  };
}

/** Matrix content that replaces one of Penny's messages with new text (m.replace). */
export function editContent(eventId: string, text: string, pennyId: string): Record<string, unknown> {
  const r = renderMentions(text, pennyId);
  const mentions = r.userIds.length ? { user_ids: r.userIds } : {};
  const fresh = {
    msgtype: 'm.text',
    body: r.body,
    ...(r.html ? { format: 'org.matrix.custom.html', formatted_body: r.html } : {}),
    'm.mentions': mentions,
  };
  return {
    msgtype: 'm.text',
    body: `* ${r.body}`,
    'm.new_content': fresh,
    'm.mentions': mentions,
    'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
  };
}
