// One Durable Object per room. A room is a thin echo for now: every message a socket sends
// is broadcast to the other sockets of the same room. Sockets are accepted through the
// WebSocket Hibernation API, so an idle room is evicted from memory and costs nothing.
import { DurableObject } from 'cloudflare:workers';

export class Room extends DurableObject {
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      try {
        other.send(message);
      } catch {
        // A socket closing at this very moment must not stop the broadcast to the rest.
      }
    }
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed by the runtime's automatic close reply.
    }
  }
}

// The Worker itself serves nothing: it has no route and no workers.dev URL.
export default {
  async fetch() {
    return new Response('Not found', { status: 404 });
  },
};
