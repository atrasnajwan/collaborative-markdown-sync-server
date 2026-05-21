import http from "http"
import jwt, { type JwtPayload } from "jsonwebtoken"
import { config } from "../config/config.js"
import { logger } from "../services/logger.js"
import type { WebSocket } from "ws"
import grpc from "@grpc/grpc-js"
import { GrpcRequestMeta } from "../grpc/server.js"

export type AuthInfo = {
  userId: string
}

/**
 * Verify a JWT
 * and extract the user id.
 */
export function verifyClientAuthToken(token: string, ws: WebSocket): AuthInfo {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET)

    const payload: JwtPayload =
      typeof decoded === "string" ? JSON.parse(decoded) : (decoded as JwtPayload)

    const raw = payload.user_id as number | string | undefined

    // Payload Validation
    if (raw === undefined) {
      logger.error("JWT missing user_id claim")
      closeWithError(ws, "Invalid token payload")
      throw new Error("JWT missing user_id claim")
    }

    const userId = typeof raw === "number" ? String(raw) : raw
    return { userId }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    let reason = "Unauthorized"
    if (err?.name === "TokenExpiredError") {
      reason = "Token expired"
      logger.warn({ token }, "Client attempted connection with expired token")
    } else {
      logger.warn({ err }, "JWT verification failed")
    }

    closeWithError(ws, reason)
    throw err
  }
}

function closeWithError(ws: WebSocket, reason: string) {
  ws.close(4001, reason)
}

export function authenticateApiCall(headers: http.IncomingHttpHeaders): boolean {
  return headers["x-internal-secret"] === config.INTERNAL_SECRET
}

export function setGrpcAuth(meta: grpc.Metadata): grpc.Metadata {
  meta.set("x-internal-secret", config.BACKEND_API_SECRET)
  return meta
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function authenticateGrpcCall(call: grpc.ServerUnaryCall<GrpcRequestMeta, {}>): boolean {
  const metadata = call.metadata.get("x-internal-secret")

  if (metadata.length === 0) return false
  return String(metadata[0]) === config.INTERNAL_SECRET
}
