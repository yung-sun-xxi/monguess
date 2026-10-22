// /api/room/<id>: the WebSocket into one live room. The room is a Durable Object of class
// Room in the separate Worker monguess-rooms (rooms/), bound here as ROOMS (see
// wrangler.toml); the same id always reaches the same object. The request, upgrade
// included, is forwarded to it unchanged, so the game keeps one origin.

const ID = /^[a-z0-9]{1,16}$/;

export async function onRequest({ request, env, params }) {
  const id = params.id;
  if (typeof id !== 'string' || !ID.test(id)) {
    return new Response('Bad room id', { status: 400 });
  }
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected a WebSocket upgrade', { status: 426 });
  }
  return env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(request);
}
