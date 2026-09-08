// Durable Object: one instance per game room.
// Holds authoritative room state and relays messages between the two
// connected players. See ../two-player-tetris-spec.md for the protocol.

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

type RoomStatus = "waiting" | "countdown" | "playing" | "finished";

interface PlayerSession {
  playerId: string;
  nickname: string;
  socket: WebSocket;
  score: number;
  linesCleared: number;
  alive: boolean;
  wantsRematch: boolean;
}

const MAX_PLAYERS = 2;
const COUNTDOWN_SECONDS = 3;

function randomId(len = 8): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

export class Room {
  state: DurableObjectState;
  env: Env;

  roomId: string | null = null;
  seed: number = 0;
  status: RoomStatus = "waiting";
  players: Map<string, PlayerSession> = new Map();
  winnerId?: string;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    if (!this.roomId) {
      const parts = url.pathname.split("/").filter(Boolean); // ["room", "ABC123"]
      this.roomId = parts[1] ?? randomId(6);
    }

    if (this.players.size >= MAX_PLAYERS) {
      return new Response("Room is full", { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    server.accept();
    this.handleSession(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleSession(socket: WebSocket) {
    const playerId = randomId(10);
    const session: PlayerSession = {
      playerId,
      nickname: `Player${this.players.size + 1}`,
      socket,
      score: 0,
      linesCleared: 0,
      alive: true,
      wantsRematch: false,
    };

    socket.addEventListener("message", (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string);
        this.handleMessage(session, msg);
      } catch (err) {
        // ignore malformed messages
      }
    });

    const cleanup = () => {
      this.players.delete(session.playerId);
      this.broadcast(
        { type: "opponent_left", payload: { playerId: session.playerId } },
        session.playerId
      );
      if (this.players.size === 0) {
        this.status = "waiting";
        this.seed = 0;
      }
    };
    socket.addEventListener("close", cleanup);
    socket.addEventListener("error", cleanup);

    this.players.set(playerId, session);

    socket.send(
      JSON.stringify({
        type: "welcome",
        payload: { playerId, roomId: this.roomId, status: this.status },
      })
    );
  }

  private handleMessage(session: PlayerSession, msg: { type: string; payload?: any }) {
    switch (msg.type) {
      case "join": {
        if (msg.payload?.nickname) {
          session.nickname = String(msg.payload.nickname).slice(0, 20);
        }
        this.broadcastRoster();
        if (this.players.size === MAX_PLAYERS && this.status === "waiting") {
          this.startCountdown();
        }
        break;
      }

      case "state_update": {
        if (msg.payload) {
          if (typeof msg.payload.score === "number") session.score = msg.payload.score;
          if (typeof msg.payload.linesCleared === "number")
            session.linesCleared = msg.payload.linesCleared;
        }
        this.relay(session, {
          type: "state_update",
          payload: { playerId: session.playerId, ...msg.payload },
        });
        break;
      }

      case "garbage": {
        this.relay(session, {
          type: "garbage",
          payload: { playerId: session.playerId, ...msg.payload },
        });
        break;
      }

      case "game_over": {
        session.alive = false;
        if (typeof msg.payload?.finalScore === "number") session.score = msg.payload.finalScore;

        const others = [...this.players.values()].filter(
          (p) => p.playerId !== session.playerId
        );
        const stillAlive = others.find((p) => p.alive);

        this.status = "finished";
        this.winnerId = stillAlive ? stillAlive.playerId : undefined;

        this.broadcast({
          type: "game_over",
          payload: {
            playerId: session.playerId,
            finalScore: session.score,
            winnerId: this.winnerId,
          },
        });
        break;
      }

      case "rematch": {
        session.wantsRematch = true;
        const all = [...this.players.values()];
        if (all.length === MAX_PLAYERS && all.every((p) => p.wantsRematch)) {
          for (const p of all) {
            p.score = 0;
            p.linesCleared = 0;
            p.alive = true;
            p.wantsRematch = false;
          }
          this.winnerId = undefined;
          this.startCountdown();
        } else {
          this.broadcast({
            type: "rematch_pending",
            payload: { playerId: session.playerId },
          });
        }
        break;
      }
    }
  }

  private startCountdown() {
    this.status = "countdown";
    this.seed = Math.floor(Math.random() * 2 ** 31);
    this.broadcast({
      type: "start_game",
      payload: { seed: this.seed, countdown: COUNTDOWN_SECONDS },
    });
    this.status = "playing";
  }

  private broadcastRoster() {
    const roster = [...this.players.values()].map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
    }));
    this.broadcast({ type: "roster", payload: { players: roster, status: this.status } });
  }

  /** Send to every connected player except the sender. */
  private relay(sender: PlayerSession, message: unknown) {
    for (const p of this.players.values()) {
      if (p.playerId !== sender.playerId) this.trySend(p, message);
    }
  }

  /** Send to every connected player, optionally excluding one playerId. */
  private broadcast(message: unknown, excludePlayerId?: string) {
    for (const p of this.players.values()) {
      if (p.playerId !== excludePlayerId) this.trySend(p, message);
    }
  }

  private trySend(session: PlayerSession, message: unknown) {
    try {
      session.socket.send(JSON.stringify(message));
    } catch (err) {
      // socket likely closed; cleanup handler will remove it
    }
  }
}
