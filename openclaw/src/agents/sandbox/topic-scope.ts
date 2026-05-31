import { parseRawSessionConversationRef } from "../../sessions/session-key-utils.js";

// Telegram's General forum topic is thread id 1. It is not a per-agent topic
// (the channel excludes it when resolving forum thread targets), so
// telegram-topic isolation deliberately skips it.
const TELEGRAM_GENERAL_TOPIC_ID = "1";

const TELEGRAM_TOPIC_MARKER = ":topic:";

/**
 * True when a session originates from a Telegram **group forum topic** —
 * channel `telegram`, a group peer, and a peer id of the form
 * `<chatId>:topic:<topicId>` — excluding the General topic.
 *
 * Direct/DM peers and non-forum groups return false, so
 * `sandbox.mode: "telegram-topic"` isolates only real per-topic agent work and
 * leaves DMs, non-topic groups, and CLI runs on the host. The session-key
 * parser handles the canonical `agent:<agentId>:<channel>:<kind>:<peer>` form.
 */
export function isTelegramGroupTopic(sessionKey: string | undefined | null): boolean {
  const ref = parseRawSessionConversationRef(sessionKey);
  if (!ref || ref.channel !== "telegram" || ref.kind !== "group") {
    return false;
  }
  const markerIndex = ref.rawId.indexOf(TELEGRAM_TOPIC_MARKER);
  if (markerIndex === -1) {
    return false;
  }
  const topicId = ref.rawId
    .slice(markerIndex + TELEGRAM_TOPIC_MARKER.length)
    .split(":")[0]
    ?.trim();
  if (!topicId || topicId === TELEGRAM_GENERAL_TOPIC_ID) {
    return false;
  }
  return true;
}
