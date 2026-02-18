import http from "http"
import * as Y from "yjs"
import { Room, UserRole } from "./types.js"
import { config } from "./config.js"

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

  try {
    // GET /internal/documents/:id/state
    if (method === "GET" && action === "state") {
      const binary = Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString("base64")
      return sendJSON(res, 200, { binary })
    }

    // DELETE /internal/documents/:id
    if (method === "DELETE" && !action) {
      room.conns.forEach(conn => {
        conn.ws.send(JSON.stringify({ type: "document-deleted" }))
        conn.ws.close(1008, "document deleted")
      })
      rooms.delete(roomName)

      return sendJSON(res, 204)
    }

    // PUT /internal/documents/:id/permission
    if (method === "PUT" && action === "permission") {
      const body = await getBody(req)
      const { user_id, role } = JSON.parse(body)

      let updated = false
      room.conns.forEach(conn => {
        if (conn.userId === String(user_id)) {
          conn.userRole = role
          updated = true
          if (role === UserRole.None) {
            conn.ws.send(JSON.stringify({type: "kicked"}))
            conn.ws.close(1008, "No access")
          } else {
            conn.ws.send(
              JSON.stringify({
                type: "permission-changed",
                role,
              }),
            )
          }
        }
      })
      return sendJSON(res, 200, { ok: true, updated })
    }
  } catch (err) {
    return sendJSON(res, 400, { error: "Request failed" })
  }

  sendJSON(res, 404)
}
