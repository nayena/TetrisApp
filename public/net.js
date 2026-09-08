// WebSocket client wrapper: connects to /room/:id on the Worker/Durable
// Object, sends/receives the message types from the spec, and exposes a
// small event-callback API to the UI layer.

export class Net {
  constructor(roomId) {
    this.roomId = roomId;
    this.ws = null;
    this.playerId = null;
    this.handlers = {};
    this._connectedResolvers = [];
  }

  on(type, handler) {
    this.handlers[type] = handler;
  }

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/room/${encodeURIComponent(this.roomId)}`;
    this.ws = new WebSocket(url);

    this.ws.addEventListener("open", () => {
      this._connectedResolvers.forEach((r) => r());
      this._connectedResolvers = [];
    });

    this.ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "welcome") this.playerId = msg.payload.playerId;
      const handler = this.handlers[msg.type];
      if (handler) handler(msg.payload);
    });

    this.ws.addEventListener("close", () => {
      const handler = this.handlers["disconnected"];
      if (handler) handler();
    });

    this.ws.addEventListener("error", () => {
      const handler = this.handlers["error"];
      if (handler) handler();
    });

    return new Promise((resolve) => this._connectedResolvers.push(resolve));
  }

  _send(type, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    }
  }

  join(nickname) {
    this._send("join", { nickname });
  }

  sendStateUpdate(state) {
    this._send("state_update", state);
  }

  sendGarbage(lines) {
    this._send("garbage", { lines });
  }

  sendGameOver(finalScore) {
    this._send("game_over", { finalScore });
  }

  sendRematch() {
    this._send("rematch", {});
  }
}
