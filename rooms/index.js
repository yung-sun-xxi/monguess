// One Durable Object per live room: a thin shell around the rules in rules.js, which also
// documents the message protocol. The shell only moves things around: it loads the room's
// state from storage, feeds one event to step(), saves the new state, sets the alarm and
// delivers the messages. Sockets are accepted through the WebSocket Hibernation API, so an
// idle room is evicted from memory; everything it needs lives in storage, and each socket
// carries its playerId as a serialized attachment.
import { DurableObject } from 'cloudflare:workers';
import rules from './rules.js';

const { step } = rules;
const CLIENT_TYPES = ['create', 'join', 'start', 'guess'];

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
    let msg;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return reply(ws, 'bad-message', 'Not JSON.');
    }
    if (!msg || !CLIENT_TYPES.includes(msg.type)) return reply(ws, 'bad-message', 'Unknown message type.');
    const attached = ws.deserializeAttachment()?.playerId ?? null;
    let playerId = attached;
    if (msg.type === 'create' || msg.type === 'join') {
      if (attached && attached !== msg.playerId) return reply(ws, 'bad-player', 'This socket is another player.');
      if (typeof msg.playerId !== 'string') return reply(ws, 'bad-player', 'Bad playerId.');
      playerId = msg.playerId;
      // From here on the socket speaks for playerId, so the answer to this message reaches it.
      if (!attached) ws.serializeAttachment({ playerId });
    } else if (!attached) {
      return reply(ws, 'not-in-room', 'Send create or join first.');
    }
    await this.apply({ ...msg, playerId });
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed by the runtime's automatic close reply.
    }
    await this.gone(ws);
  }

  async webSocketError(ws) {
    await this.gone(ws);
  }

  async alarm() {
    await this.apply({ type: 'alarm' });
  }

  // A closed socket is its player leaving, unless the same player has another tab open.
  async gone(ws) {
    const playerId = ws.deserializeAttachment()?.playerId;
    if (!playerId) return;
    const still = this.ctx.getWebSockets().some(
      (other) => other !== ws && other.readyState === WebSocket.OPEN
        && other.deserializeAttachment()?.playerId === playerId,
    );
    if (!still) await this.apply({ type: 'leave', playerId });
  }

  async apply(event) {
    const storage = this.ctx.storage;
    const before = (await storage.get('state')) ?? null;
    const now = Date.now();
    // A player stored as connected with no open socket left without a close event (the
    // runtime restarted or dropped the socket): they leave now, so the grace counts from here.
    let current = before;
    const out = [];
    for (const playerId of this.vanished(before, event)) {
      const left = step(current, { type: 'leave', playerId }, now);
      current = left.state;
      out.push(...left.out);
    }
    const result = step(current, event, now);
    const { state, alarmAt } = result;
    out.push(...result.out);
    if (state) {
      if (state !== before) await storage.put('state', state);
    } else if (before) {
      // Idle expiry: the room is gone, and so are its sockets.
      await storage.deleteAlarm();
      await storage.deleteAll();
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(4000, 'room expired');
        } catch {
          // Already closing.
        }
      }
      return;
    }
    if (alarmAt === null) await storage.deleteAlarm();
    else await storage.setAlarm(alarmAt);
    this.deliver(out, state);
  }

  // The leave being applied is not counted twice.
  vanished(state, event) {
    if (!state) return [];
    const open = new Set(this.ctx.getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.OPEN)
      .map((ws) => ws.deserializeAttachment()?.playerId));
    return Object.entries(state.players).filter(([id, p]) => p.connected && !open.has(id) && !(event.type === 'leave' && event.playerId === id))
      .map(([id]) => id);
  }

  deliver(out, state) {
    const sockets = this.ctx.getWebSockets().map((ws) => [ws, ws.deserializeAttachment()?.playerId]);
    for (const { to, msg } of out) {
      const text = JSON.stringify(msg);
      for (const [ws, playerId] of sockets) {
        const mine = to === 'all' ? Boolean(state && playerId && state.players[playerId]) : playerId === to;
        if (!mine) continue;
        try {
          ws.send(text);
        } catch {
          // A socket closing at this very moment must not stop delivery to the rest.
        }
      }
    }
  }
}

function reply(ws, code, message) {
  try {
    ws.send(JSON.stringify({ type: 'error', code, message }));
  } catch {
    // Closing.
  }
}

// The Worker itself serves nothing: it has no route and no workers.dev URL.
export default {
  async fetch() {
    return new Response('Not found', { status: 404 });
  },
};
