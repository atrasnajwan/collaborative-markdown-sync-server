import 'dotenv/config';
import { intFromEnv } from "./env.js";

export type Config = {
  PORT: number;
  HOST: string;
  BACKEND_API_URL: string;
  BACKEND_API_SECRET: string;
  FORWARD_DEBOUNCE_MS: number;
  JWT_SECRET: string;
  ROOM_TTL_MS: number;
};

export const config: Config = {
  PORT: intFromEnv("PORT", 8787),
  HOST: process.env.HOST ?? "0.0.0.0",
  BACKEND_API_URL: process.env.BACKEND_API_URL ?? "",
  BACKEND_API_SECRET: process.env.BACKEND_API_SECRET ?? "collab-internal-secret",
  JWT_SECRET: process.env.JWT_SECRET ?? "",
  FORWARD_DEBOUNCE_MS: intFromEnv("FORWARD_DEBOUNCE_MS", 0),
  ROOM_TTL_MS: intFromEnv("ROOM_TTL_MS", 10 * 60 * 1000), // 10 minutes default
};

export function normalizeRoomFromUrl(reqUrl: string | undefined): string | null {
  if (!reqUrl) return null;
  const u = new URL(reqUrl, `http://${config.HOST}:${config.PORT}`);
  const path = u.pathname || "/";

  const room = decodeURIComponent(path).replace(/^\/+/, "");
  return room.length ? room : "default";
}

