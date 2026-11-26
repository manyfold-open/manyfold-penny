/**
 * Rooms Penny's own gateway hands to narra-agent-kit's chat-native (v2) pipeline (src/worker/kit.ts).
 *
 * During the room-by-room move both gateways read the same Matrix account, and each room must have
 * exactly one of them. A room belongs to the kit while the kit is on (NARRA_GATEWAY_ENABLED = "on"
 * and NARRA_AGENT_TOKEN set) and the room is listed in NARRA_PIPELINE_ROOMS; Penny's gateway
 * then never reads, answers, reminds, recaps or welcomes there. The kit runs with
 * NARRA_PIPELINE_ONLY_LISTED = "on" and NARRA_PIPELINE = "v2", so it ignores every room that is
 * not listed and serves the listed ones with v2 (tests/kit.test.ts checks wrangler.jsonc for both).
 *
 * Switching the kit off (NARRA_GATEWAY_ENABLED != "on") gives the room straight back to Penny's
 * gateway.
 */

import type { Env } from '../types';

export function kitRoomIds(env: Env): string[] {
  const on = (env.NARRA_GATEWAY_ENABLED ?? '').trim() === 'on' && (env.NARRA_AGENT_TOKEN ?? '').trim().length > 0;
  if (!on) return [];
  return (env.NARRA_PIPELINE_ROOMS ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
}

/** True when the kit, not Penny's own gateway, serves this room. */
export function handledByKit(env: Env, roomId: string): boolean {
  return Boolean(roomId) && kitRoomIds(env).includes(roomId);
}
