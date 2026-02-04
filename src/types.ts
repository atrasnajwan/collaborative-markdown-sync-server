import type { WebSocket } from "ws";
import type * as Y from "yjs";
import type * as awarenessProtocol from "y-protocols/awareness";
import { UserRole } from "./internalApi.js";
import EventEmitter from "node:events";

export type RoomName = string;

export type ForwardQueue = {
  timer?: NodeJS.Timeout;
  updates: Uint8Array[];
};

export type Conn = {
  id: string;
  ws: WebSocket;
  room: RoomName;
  awarenessClientId: number;
  closed: boolean;
  userId: string;
  userRole: UserRole,
  synced: boolean
};

export type Room = {
  name: RoomName;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Set<Conn>;
  lastActiveAt: number;
  forwardQueue?: ForwardQueue;
  ready: boolean,
  emitter: EventEmitter;
};

