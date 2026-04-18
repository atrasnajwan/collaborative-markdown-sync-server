import { UserRole } from "../types/user.js"
import { isWsOpen } from "../utils/utils.js"
import { rooms } from "./rooms.js"

/**
 * Notify client its role changed
 */
export async function handleUserRoleChanged(
  roomName: string,
  userId: string,
  role: string,
): Promise<number> {
  const room = rooms.get(roomName)
  if (!room) return 0

  const notificationPromises: Promise<void>[] = []

  room.conns.forEach(conn => {
    if (conn.userId === String(userId)) {
      conn.userRole = role as UserRole
      if (isWsOpen(conn.ws)) {
        // Create a promise for each WS notification
        const promise = new Promise<void>((resolve, reject) => {
          if (role === UserRole.None) {
            // kick client from room
            conn.ws.send(JSON.stringify({ type: "kicked" }), err => {
              if (err) return reject(err)
              conn.ws.close(1008, "No access")
              resolve()
            })
          } else {
            conn.ws.send(JSON.stringify({ type: "permission-changed", role }), err => {
              if (err) return reject(err)
              resolve()
            })
          }
        })
        notificationPromises.push(promise)
      }
    }
  })
  await Promise.all(notificationPromises)
  return notificationPromises.length
}
