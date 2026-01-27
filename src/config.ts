import { intFromEnv } from "./env.js";

export type Config = {
  PORT: number;
  HOST: string;
};

export const config: Config = {
  PORT: intFromEnv("PORT", 8787),

export function normalizeRoomFromUrl(reqUrl: string | undefined): string | null {
  if (!reqUrl) return null;
  const u = new URL(reqUrl, `http://${config.HOST}:${config.PORT}`);
  const path = u.pathname || "/";

  const room = decodeURIComponent(path).replace(/^\/+/, "");
  return room.length ? room : "default";
}

