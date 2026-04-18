import type { WebSocket } from "ws"

export function isWsOpen(ws: WebSocket): boolean {
  return ws.readyState === ws.OPEN
}

export function decodeBase64ToUint8Array(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"))
}

export function toBase64(buffer: Buffer | Uint8Array | undefined): string {
  if (!buffer) return ""
  return Buffer.from(buffer).toString("base64")
}
