// POST /api/log: one record per game, kept in Workers KV (binding LOG, see wrangler.toml).
// The game posts the same record more than once (start, end, page closed); every post for a
// game lands on one key, so the latest one wins. Only the body is stored: no IP, no headers.
// Nothing here may throw: a full KV day on the Free plan must cost the game nothing.

const MAX_BYTES = 32768;
const ID = /^[a-z0-9]{12,32}$/;
const PAST_MS = 2 * 24 * 60 * 60 * 1000;
const FUTURE_MS = 10 * 60 * 1000;
// Keys sort newest first in a plain lexicographic list: the larger startedAt, the smaller key.
const KEY_BASE = 9999999999999;

const reply = (status) => new Response(null, { status });

export async function onRequestPost({ request, env }) {
  let text;
  let record;
  try {
    text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BYTES) return reply(400);
    record = JSON.parse(text);
  } catch {
    return reply(400);
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return reply(400);
  const { id, startedAt } = record;
  if (typeof id !== 'string' || !ID.test(id)) return reply(400);
  const now = Date.now();
  if (typeof startedAt !== 'number' || !(startedAt >= now - PAST_MS && startedAt <= now + FUTURE_MS)) {
    return reply(400);
  }
  const key = `${String(KEY_BASE - startedAt).padStart(13, '0')}-${id}`;
  try {
    await env.LOG.put(key, text);
  } catch {
    return reply(503);
  }
  return reply(204);
}
