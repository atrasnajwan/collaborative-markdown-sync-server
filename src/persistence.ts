import * as Y from "yjs";
import type { Room } from "./types.js";
import { config } from "./config.js";

type DocumentUpdateDTO = {
  seq: number;
  binary: string; // JSON []byte becomes base64 string
};

type DocumentStateResponse = {
  title: string;
  snapshot: string; // base64
  snapshot_seq: number;
  updates: DocumentUpdateDTO[];
};

function decodeBase64ToUint8Array(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Fetch initial document state for a room from the API server
 * and apply it to the room's Y.Doc. Requires a BACKEND_API_SECRET for auth.
 */
export async function hydrateRoomFromBackend(room: Room) {
  // /internal/documents/:id/state
  const url = `${config.BACKEND_API_URL}/internal/documents/${room.name.replace("doc-", "")}/last-state`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "authorization": `Bearer ${config.BACKEND_API_SECRET}`,
  };

  const res = await fetch(url, { headers });
  if (!res.ok) return;

  const body = (await res.json()) as DocumentStateResponse;
  // Apply snapshot first (if present)
  if (body.snapshot && body.snapshot.length > 0) {
    const snapshotUpdate = decodeBase64ToUint8Array(body.snapshot);
    Y.applyUpdate(room.doc, snapshotUpdate);
  }

  // Then apply all incremental updates in order of seq
  const sortedUpdates = [...body.updates].sort((a, b) => a.seq - b.seq);
  for (const u of sortedUpdates) {
    if (!u.binary) continue;

    const update = decodeBase64ToUint8Array(u.binary);
    Y.applyUpdate(room.doc, update);
  }
}