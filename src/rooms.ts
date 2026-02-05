import { randomUUID } from "node:crypto";

import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import type { WebSocket } from "ws";

import { config } from "./config.js";
import { forwardUpdate } from "./forwarding.js";
import { broadcastAwarenessUpdate, broadcastDocUpdate } from "./yjsProtocol.js";
import { UserRole, type Conn, type Room, type RoomName } from "./types.js";
import { verifyAuthToken } from "./auth.js";
import { hydrateRoomFromBackend } from "./persistence.js";
import { fetchUserRole } from "./internalApi.js";
import EventEmitter from "node:events";

/**
 * In‑memory registry of all active rooms
 */
export const rooms = new Map<RoomName, Room>();

/**
 * Get an existing room or create a new Y.Doc + Awareness instance for `name`.
 * Also wires up listeners to broadcast and forward document updates.
 *
 */
export function getOrCreateRoom(name: RoomName): Room {
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
    ready: false,
    emitter: new EventEmitter()
  };

  rooms.set(name, room);
  
  // set initial content
  hydrateRoomFromBackend(room).then(() => {
    room.ready = true
  
    setupDocListeners(room)
    setupAwarenessListeners(room)
    // Tell everyone waiting: "The data is ready!"
    room.emitter.emit('ready');
  })
  
  return room;
}

function setupDocListeners(room: Room) {
  room.doc.on("update", (update: Uint8Array, origin: unknown) => {
    // get origin connection
    let originConn: Conn | undefined;
    if (origin && typeof origin === "object" && "send" in (origin as any)) {
      const originWs = origin as WebSocket;
      originConn = Array.from(room.conns).find((c) => c.ws === originWs);
    }

    // only owner and editor can edit document
    if (!originConn || (originConn.userRole !== UserRole.Owner && originConn.userRole !== UserRole.Editor)) return;
    broadcastDocUpdate(room, update, origin);

    // skip forward update if it's not from origin
    if (!originConn) return;
    forwardUpdate(room, update, originConn).catch((err) => {
      console.log(err);
    });
  });
}

function setupAwarenessListeners(room: Room) {
  room.awareness.on("update",
    (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const changedClients = added.concat(updated, removed);
      if (changedClients.length === 0) return;

      broadcastAwarenessUpdate(room, changedClients, origin);
    },
  );
}

/**
 * Mark a room as recently used, so GC does not collect it too early.
 */
export function touchRoom(room: Room) {
  room.lastActiveAt = Date.now();
}

export async function createConn(ws: WebSocket, roomName: RoomName, authToken: string): Promise<Conn> {
  // Yjs awareness identifies each client by a numeric ID, so we generate
  // a random 31‑bit integer for this WebSocket connection and reuse it
  // for the life of the connection.
  const awarenessClientId = (Math.random() * 0x7fffffff) | 0;
  const { userId } = verifyAuthToken(authToken);
  const docId = roomName.replace("doc-", "");
  const userRole = (await fetchUserRole(docId, userId)).role
  const conn = {
    id: randomUUID(),
    ws,
    room: roomName,
    awarenessClientId,
    closed: false,
    userId,
    userRole,
    synced: false
  };
  return conn;
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
      removeRoom(room, name) 
    }
  }, config.ROOM_TTL_MS);
}

export function removeRoom(room: Room, name: string) {
  room.doc.destroy();
  rooms.delete(name);
}
