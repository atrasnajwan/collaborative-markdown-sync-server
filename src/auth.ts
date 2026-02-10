import jwt, { type JwtPayload } from "jsonwebtoken"
import { config } from "./config.js"

export type AuthInfo = {
  userId: string
}

/**
 * Verify a JWT
 * and extract the user id.
 */
export function verifyAuthToken(token: string): AuthInfo {
  if (!config.JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured")
  }

  const decoded = jwt.verify(token, config.JWT_SECRET)
  const payload: JwtPayload =
    typeof decoded === "string" ? (JSON.parse(decoded) as JwtPayload) : (decoded as JwtPayload)

  const raw = (payload as any).user_id as number | string | undefined
  if (raw === undefined) {
    throw new Error("JWT missing user_id claim")
  }

  const userId = typeof raw === "number" ? String(raw) : raw
  return { userId }
}
