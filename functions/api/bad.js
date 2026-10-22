// /api/bad: images players marked as bad ("Плохая картинка"), hidden from every game for good.
//   POST { src, id }  adds one image to the list.
//   GET               the whole list, a JSON array of "src:id" keys; the game skips them.
// The list is one value under one key in Workers KV (binding LOG, the game log's namespace,
// see wrangler.toml): a GET is one KV read and never a list call, which the Free plan
// rations hardest. Validation and the list logic are lib.js (badImageKey, parseBadList,
// addBadImage). Nothing here may throw: a full KV day on the Free plan must cost the game
// nothing.
import MG from '../../lib.js';

// Not a number, so the game log's newest-first keys (all digits) sort before it.
const KEY = 'bad-images';
const MAX_BYTES = 1024;
// A minute of browser cache: a game started right after a press may still see the old list.
const MAX_AGE_S = 60;

const reply = (status) => new Response(null, { status });

// The stored list as keys, [] when there is none yet; throws when KV fails or the stored
// value is not JSON, so that a write never replaces a list it could not read.
async function readList(env) {
  const text = await env.LOG.get(KEY);
  return text === null ? [] : MG.parseBadList(JSON.parse(text));
}

export async function onRequestGet({ env }) {
  let list;
  try {
    list = await readList(env);
  } catch {
    return reply(503);
  }
  return new Response(JSON.stringify(list), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${MAX_AGE_S}` },
  });
}

export async function onRequestPost({ request, env }) {
  let key;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BYTES) return reply(400);
    key = MG.badImageKey(JSON.parse(text));
  } catch {
    return reply(400);
  }
  if (key === null) return reply(400);
  // Read, add, write back: two presses within the same moment can lose one of them.
  try {
    const list = await readList(env);
    const next = MG.addBadImage(list, key);
    if (next === null) return reply(507);
    if (next !== list) await env.LOG.put(KEY, JSON.stringify(next));
  } catch {
    return reply(503);
  }
  return reply(204);
}
