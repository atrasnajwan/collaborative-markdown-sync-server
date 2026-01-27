import type { WebSocket } from "ws";
import type * as Y from "yjs";
import type * as awarenessProtocol from "y-protocols/awareness";

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
  authToken?: string;
};

export type Room = {
  name: RoomName;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Set<Conn>;
  lastActiveAt: number;
  forwardQueue?: ForwardQueue;
};

