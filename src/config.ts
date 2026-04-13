import "dotenv/config"
import { intFromEnv } from "./env.js"

export type Config = {
  PORT: number
  HOST: string
  BACKEND_API_GRPC_ADDRESS: string // preferred; if set, grpc calls are used
  BACKEND_API_URL: string // legacy HTTP endpoint; used only when gRPC address is unset
  BACKEND_API_SECRET: string
  INTERNAL_SECRET: string
  GRPC_PORT: number // optional port to expose the internal API over gRPC
  FORWARD_DEBOUNCE_MS: number
  JWT_SECRET: string
  ROOM_TTL_MS: number
  REDIS_ADDRESS: string,
  KAFKA_BROKERS: string[]
}

export const config: Config = {
  PORT: intFromEnv("PORT", 8787),
  HOST: process.env.HOST ?? "0.0.0.0",
  BACKEND_API_GRPC_ADDRESS: process.env.BACKEND_API_GRPC_ADDRESS ?? "",
  BACKEND_API_URL: process.env.BACKEND_API_URL ?? "",
  BACKEND_API_SECRET: process.env.BACKEND_API_SECRET ?? "collab-internal-secret",
  INTERNAL_SECRET: process.env.INTERNAL_SECRET ?? "collab-sync-secret",
  GRPC_PORT: intFromEnv("GRPC_PORT", 0),
  REDIS_ADDRESS: process.env.REDIS_ADDRESS ?? "",
  JWT_SECRET: process.env.JWT_SECRET ?? "my-jwt-secret",
  FORWARD_DEBOUNCE_MS: intFromEnv("FORWARD_DEBOUNCE_MS", 0),
  ROOM_TTL_MS: intFromEnv("ROOM_TTL_MS", 10 * 60 * 1000), // 10 minutes default
  KAFKA_BROKERS: !process.env.KAFKA_BROKERS ? [] : process.env.KAFKA_BROKERS.split(',')
}

export function normalizeRoomFromUrl(reqUrl: string | undefined): string | null {
  if (!reqUrl) return null
  const u = new URL(reqUrl, `http://${config.HOST}:${config.PORT}`)
  const path = u.pathname || "/"

  const room = decodeURIComponent(path).replace(/^\/+/, "")
  return room.length ? room : "default"
}
