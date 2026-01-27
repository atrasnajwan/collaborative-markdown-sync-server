import { randomUUID } from "node:crypto";

import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import type { WebSocket } from "ws";

import { config } from "./config.js";
import { forwardUpdate } from "./forwarding.js";
import { broadcastAwarenessUpdate, broadcastDocUpdate } from "./yjsProtocol.js";
import type { Conn, Room, RoomName } from "./types.js";
import { hydrateRoomFromBackend } from "./persistence.js";

/**
 * In‑memory registry of all active rooms
 */
export const rooms = new Map<RoomName, Room>();

/**
 * Get an existing room or create a new Y.Doc + Awareness instance for `name`.
 * Also wires up listeners to broadcast and forward document updates.
 *
 * Accepts a JWT auth token which is used to hydrate the room
 * from the backend when it is first created.
 */
export function getOrCreateRoom(name: RoomName, authToken?: string): Room {
  const existing = rooms.get(name);
  if (existing) return existing;

  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);

  const room: Room = {
    name,
    doc,
    awareness,
    conns: new Set(),
    lastActiveAt: Date.now(),
  };

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    broadcastDocUpdate(room, update, origin);
    // find the originating connection so we can forward using
    // that client's JWT
    let authToken: string | undefined;
    if (origin && typeof origin === "object" && "send" in (origin as any)) {
      const originWs = origin as WebSocket;
      const originConn = Array.from(room.conns).find((c) => c.ws === originWs);
      authToken = originConn?.authToken;
    }

    // call backend api
    forwardUpdate(room, update, authToken).catch((err) => {
      console.log(err)
    });
  });

  awareness.on("update",
    (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const changedClients = added.concat(updated, removed);
      if (changedClients.length === 0) return;

      broadcastAwarenessUpdate(room, changedClients, origin);
    },
  );

  rooms.set(name, room);
  hydrateRoomFromBackend(room, authToken).catch((err) => {
    console.log(err)
  });
  return room;
}

/**
 * Mark a room as recently used, so GC does not collect it too early.
 */
export function touchRoom(room: Room) {
  room.lastActiveAt = Date.now();
}

export function createConn(ws: WebSocket, roomName: RoomName): Conn {
  // Yjs awareness identifies each client by a numeric ID, so we generate
  // a random 31‑bit integer for this WebSocket connection and reuse it
  // for the life of the connection.
  const awarenessClientId = (Math.random() * 0x7fffffff) | 0;
  return {
    id: randomUUID(),
    ws,
    room: roomName,
    awarenessClientId,
    closed: false,
  };
}

/**
 * Remove a connection from the room and clear its awareness state.
 */
export function cleanupConn(room: Room, conn: Conn) {
  if (conn.closed) return;
  conn.closed = true;
  room.conns.delete(conn);

  awarenessProtocol.removeAwarenessStates(room.awareness, [conn.awarenessClientId], conn.ws);
  touchRoom(room);
}

/**
 * Periodically scan for idle rooms(unused for certain time) and destroy their Y.Doc instances.
 */
export function setupRoomDestroyer() {
  setInterval(() => {
    const now = Date.now();
    for (const [name, room] of rooms.entries()) {
      if (room.conns.size > 0) continue;
      if (now - room.lastActiveAt < config.ROOM_TTL_MS) continue;
      room.doc.destroy();
      rooms.delete(name);
    }
  }, config.ROOM_TTL_MS);
}

