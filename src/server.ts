import { createServer, Server } from "node:http";

import { WebSocketServer } from "ws";
import * as Y from "yjs";

import { normalizeRoomFromUrl, config } from "./config.js";
import { cleanupConn, createConn, getOrCreateRoom, rooms, setupRoomDestroyer, touchRoom } from "./rooms.js";
import { handleIncoming, sendAwareness, sendInitSyncStep } from "./yjsProtocol.js";
import { postDocumentSnapshot } from "./internalApi.js";
import { handleInternalAPI } from "./apiHandlers.js";

/**
 * Boot the HTTP + WebSocket server.
 *
 * - Exposes a `/healthz` HTTP endpoint.
 * - Exposes a `/internal/` endpoint
 * - Accepts WebSocket connections on `ws://HOST:PORT/<room>`.
 */
export function startServer(): Server {
  const httpServer = createServer((req, res) => {
    const { url } = req;

    // Health check
    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }

    // Route Internal API Requests /internal
    if (url?.startsWith("/internal/")) {
      return handleInternalAPI(req, res, rooms);
    }

    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", async (ws, req) => {
    const roomName = normalizeRoomFromUrl(req.url);

    if (!roomName) {
      ws.close(1008, "Invalid room");
      return;
    }
    // Extract JWT from query string: ws://host:port/room?token=JWT_HERE
    let authToken: string | undefined;
    if (req.url) {
      const url = new URL(req.url, `http://${config.HOST}:${config.PORT}`);
      const token = url.searchParams.get("token");
      if (token) {
        authToken = token;
      }
    }

    if (!authToken) {
      ws.close(1008, "Unauthorized");
      return;
    }

    const room = getOrCreateRoom(roomName);
    touchRoom(room);
    
    const conn = await createConn(ws, roomName, authToken);
    room.conns.add(conn);

    room.awareness.setLocalStateField("connectionId", conn.id);


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

    // Handle the Sync Handshake
    const startSync = () => {
      console.log("sync running")
      sendInitSyncStep(ws, room);
      sendAwareness(ws, room);
      conn.synced = true;
    };

    if (room.ready) {
      console.log("start sync")
      startSync();
    } else {
      console.log("wait for hydration")
      // Wait for the hydration to finish
      room.emitter.once('ready', startSync);
    }

    ws.on("close", () => cleanupConn(room, conn));
    ws.on("error", () => cleanupConn(room, conn));
  });

  setupRoomDestroyer();

  httpServer.listen(config.PORT, config.HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`listening on http://${config.HOST}:${config.PORT}`);
  });
  
  return httpServer
}

export async function persistAllRooms() {
  const promises = Array.from(rooms.values()).map(async (room) => {
    try {
      console.log(`[Shutdown] Saving room: ${room.name}`);
      const docId = room.name.replace("doc-", "");
      const stateUpdate = Y.encodeStateAsUpdate(room.doc);
      const binary = Buffer.from(stateUpdate);

      return postDocumentSnapshot(docId, binary)
    } catch (e) {
      console.error(`[Shutdown] Failed to save ${room.name}`, e);
    }
  });
  await Promise.all(promises);
}

