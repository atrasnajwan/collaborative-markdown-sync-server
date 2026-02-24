import http from "http"
import * as Y from "yjs"
import { Room, UserRole } from "./types.js"
import { config } from "./config.js"
import { logger } from "./logger.js"

const sendJSON = (res: http.ServerResponse, status: number, data?: any) => {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(data ? JSON.stringify(data) : null)
}

const getBody = (req: http.IncomingMessage): Promise<string> => {
  return new Promise(resolve => {
    let body = ""
    req.on("data", chunk => (body += chunk))
    req.on("end", () => resolve(body))
  })
}

export async function handleInternalAPI(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rooms: Map<string, Room>,
) {
  const { method, url } = req
  if (!url) return

  // Auth
  if (req.headers["x-internal-secret"] !== config.INTERNAL_SECRET) {
    res.writeHead(403)
    return res.end()
  }

  const parts = url.split("/")
  const docId = parts[3]
  const action = parts[4]
  const roomName = `doc-${docId}`
  const room = rooms.get(roomName)

  if (!room) return sendJSON(res, 404, { error: "Document not found" })

  // GET /internal/documents/:id/state
  if (method === "GET" && action === "state") {
    try {
      const binary = Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString("base64")
      return sendJSON(res, 200, { binary })
    } catch (err) {
      logger.error({ error: err, docId }, "Failed to fetch last document state")
      return sendJSON(res, 500, { error: "Failed to fetch last document state" })
    }
  }

  // DELETE /internal/documents/:id
  if (method === "DELETE" && !action) {
    const notificationPromises: Promise<void>[] = []

    room.conns.forEach(conn => {
      // kick client from room
      const promise = new Promise<void>((resolve, reject) => {
        conn.ws.send(JSON.stringify({ type: "document-deleted" }), err => {
          if (err) return reject(err)
          conn.ws.close(1008, "document deleted")
          resolve()
        })
      })
      notificationPromises.push(promise)
    })
    // delete room
    rooms.delete(roomName)

    try {
      // Wait for all WS messages to be sent successfully
      await Promise.all(notificationPromises)

      return sendJSON(res, 204)
    } catch (wsError) {
      logger.error({ error: wsError }, "Failed to notify client of document deleted")
      return sendJSON(res, 500, { error: "Failed to notify connected clients" })
    }
  }

  // PUT /internal/documents/:id/permission
  if (method === "PUT" && action === "permission") {
    const body = await getBody(req)
    const { user_id, role } = JSON.parse(body)

    const notificationPromises: Promise<void>[] = []

    room.conns.forEach(conn => {
      if (conn.userId === String(user_id)) {
        conn.userRole = role
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
    })

    try {
      // Wait for all WS messages to be sent successfully
      await Promise.all(notificationPromises)

      return sendJSON(res, 200, {
        ok: true,
        updated: notificationPromises.length > 0,
      })
    } catch (wsError) {
      logger.error({ error: wsError, user_id }, "Failed to notify client of permission change")
      return sendJSON(res, 500, { error: "Failed to notify connected clients" })
    }
  }

  sendJSON(res, 404)
}
