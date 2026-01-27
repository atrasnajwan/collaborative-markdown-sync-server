import { intFromEnv } from "./env.js";

export type Config = {
  PORT: number;
  HOST: string;
  ROOM_TTL_MS: number;
};

export const config: Config = {
  PORT: intFromEnv("PORT", 8787),
  ROOM_TTL_MS: intFromEnv("ROOM_TTL_MS", 10 * 60 * 1000),
};

export function normalizeRoomFromUrl(reqUrl: string | undefined): string | null {
  if (!reqUrl) return null;
  const u = new URL(reqUrl, `http://${config.HOST}:${config.PORT}`);
  const path = u.pathname || "/";

  const room = decodeURIComponent(path).replace(/^\/+/, "");
  return room.length ? room : "default";
}

