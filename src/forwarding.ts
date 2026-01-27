import * as Y from "yjs";
import { config } from "./config.js";
import type { Room } from "./types.js";
import { error } from "console";

/**
 * Forward each Yjs document update to an external HTTP backend.
 * When `FORWARD_DEBOUNCE_MS` is > 0, multiple updates are merged and sent
 * as a single batched update per room. Uses the originating client's JWT
 */
export async function forwardUpdate(room: Room, update: Uint8Array, authToken?: string) {
  if (!config.BACKEND_API_URL) return;
  if (!authToken) return;

  if (config.FORWARD_DEBOUNCE_MS > 0) {
    if (!room.forwardQueue) room.forwardQueue = { updates: [] };
    room.forwardQueue.updates.push(update);
    if (!room.forwardQueue.timer) {
      room.forwardQueue.timer = setTimeout(() => {
        const q = room.forwardQueue;
        room.forwardQueue = undefined;
        if (!q) return;
        const combined = Y.mergeUpdates(q.updates);
        forwardUpdateNow(room, combined, authToken);
      }, config.FORWARD_DEBOUNCE_MS);
    }
    return;
  }
  console.log("not debounce")
  await forwardUpdateNow(room, update, authToken);
}

async function forwardUpdateNow(room: Room, update: Uint8Array, authToken: string) {
  console.log("run update")
  const url = `${config.BACKEND_API_URL}/documents/${room.name.replace("doc-", "")}/update`;
  const body = Buffer.from(update);

  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  };
  // per-connection JWT from the client
  if (authToken) {
    headers["authorization"] = `Bearer ${authToken}`;
  }

  await fetch(url, { method: "POST", headers, body }).catch(error => console.log(error));
}

