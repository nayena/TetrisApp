// Worker entry: routes requests, serves the static frontend from /public,
// and upgrades /room/:id WebSocket connections to the room's Durable Object.

export { Room } from "./room";
import type { Env } from "./room";

function randomRoomCode(len = 6): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity
  let out = "";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // API: mint a new room code (Player A clicks "Create Room").
    if (url.pathname === "/api/create-room" && request.method === "POST") {
      const roomId = randomRoomCode();
      return Response.json({ roomId });
    }

    // WebSocket upgrade -> route to the room's Durable Object instance.
    if (url.pathname.startsWith("/room/")) {
      const roomId = url.pathname.split("/")[2];
      if (!roomId) return new Response("Missing room id", { status: 400 });

      if (request.headers.get("Upgrade") === "websocket") {
        const id = env.ROOM.idFromName(roomId);
        const stub = env.ROOM.get(id);
        return stub.fetch(request);
      }

      // Normal page load for /room/ABC123 -> serve the SPA shell.
      return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
    }

    // Everything else: static assets (index.html, style.css, game.js, net.js).
    return env.ASSETS.fetch(request);
  },
};
