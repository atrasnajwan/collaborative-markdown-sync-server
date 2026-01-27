import { createServer } from "node:http";

import { WebSocketServer } from "ws";

import { normalizeRoomFromUrl, config } from "./config.js";
import { cleanupConn, createConn, getOrCreateRoom, setupRoomGc, touchRoom } from "./rooms.js";
import { handleIncoming, sendAwareness, sendInitSyncStep } from "./yjsProtocol.js";

/**
 * Boot the HTTP + WebSocket server.
 *
 * - Exposes a `/healthz` HTTP endpoint.
 * - Accepts WebSocket connections on `ws://HOST:PORT/<room>`.
 */
export function startServer() {
  const httpServer = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws, req) => {
    const roomName = normalizeRoomFromUrl(req.url);

    if (!roomName) {
      ws.close(1008, "Invalid room");
      return;
    }
    const room = getOrCreateRoom(roomName);
    touchRoom(room);

    const conn = createConn(ws, roomName);
    room.conns.add(conn);

    sendInitSyncStep(ws, room);

    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;

      const messageData: Uint8Array = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : Array.isArray(data)
            ? new Uint8Array(Buffer.concat(data))
            : new Uint8Array(data as Buffer);
      touchRoom(room);
      handleIncoming(room, conn, messageData);
    });

    ws.on("close", () => cleanupConn(room, conn));
    ws.on("error", () => cleanupConn(room, conn));
  });

  httpServer.listen(config.PORT, config.HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`listening on http://${config.HOST}:${config.PORT}`);
  });
}

