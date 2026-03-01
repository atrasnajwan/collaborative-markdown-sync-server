import jwt, { type JwtPayload } from "jsonwebtoken"
import { config } from "./config.js"
import { logger } from "./logger.js"
import type { WebSocket } from "ws"

export type AuthInfo = {
  userId: string
}

/**
 * Verify a JWT
 * and extract the user id.
 */
export function verifyAuthToken(token: string, ws: WebSocket): AuthInfo {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET)

    const payload: JwtPayload =
      typeof decoded === "string" ? JSON.parse(decoded) : (decoded as JwtPayload)

    const raw = (payload as any).user_id as number | string | undefined

    // Payload Validation
    if (raw === undefined) {
      logger.error("JWT missing user_id claim")
      closeWithError(ws, "Invalid token payload")
      throw new Error("JWT missing user_id claim")
    }

    const userId = typeof raw === "number" ? String(raw) : raw
    return { userId }
  } catch (err: any) {
    let reason = "Unauthorized"
    if (err.name === "TokenExpiredError") {
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
