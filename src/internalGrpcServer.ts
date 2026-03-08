import grpc from "@grpc/grpc-js"
import protoLoader from "@grpc/proto-loader"

import { config } from "./config.js"
import { rooms } from "./rooms.js"
import {
  fetchRoomState,
  deleteDocument,
  changeUserPermission,
  DocumentNotFoundError,
} from "./apiHandlers.js"
import { logger } from "./logger.js"

// gRPC metadata key for authentication
const INTERNAL_SECRET_KEY = "x-internal-secret"

const PROTO_PATH = new URL("../proto/server.proto", import.meta.url).pathname
const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
})

const grpcObj: any = grpc.loadPackageDefinition(packageDef)

const SyncServerInternal = grpcObj.syncserver.SyncServerInternal as grpc.ServiceClientConstructor

function authenticate(call: grpc.ServerUnaryCall<any, any>): boolean {
  const metadata = call.metadata.get(INTERNAL_SECRET_KEY)
  if (metadata.length === 0) return false
  return String(metadata[0]) === config.INTERNAL_SECRET
}

export function startInternalGrpcServer(): grpc.Server | null {
  if (!config.GRPC_PORT) {
    logger.debug("gRPC internal API disabled (no port configured)")
    return null
  }

  const server = new grpc.Server()

  server.addService(SyncServerInternal.service, {
    async GetState(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      if (!authenticate(call)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, message: "unauthorized" })
      }

      const docId = String(call.request.id || "")
      try {
        logger.debug("fetchRoomState called via gRPC")
        const binary = await fetchRoomState(docId, rooms)
        callback(null, { state: binary })
      } catch (err: any) {
        // prefer checking for the dedicated error class
        if (err instanceof DocumentNotFoundError) {
          return callback({ code: grpc.status.NOT_FOUND, message: "document not found" })
        }
        const msg = err && typeof err.message === "string" ? err.message : String(err)
        logger.debug({ errMessage: msg }, "GetState catch message")
        logger.error({ error: err, docId }, "GetState gRPC handler error")
        return callback({ code: grpc.status.INTERNAL, message: "internal error" })
      }
    },

    async DeleteDocument(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      if (!authenticate(call)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, message: "unauthorized" })
      }

      const docId = String(call.request.id || "")
      try {
        logger.debug("DeleteDocument called via gRPC")
        await deleteDocument(docId)
        callback(null, {})
      } catch (err) {
        logger.error({ error: err, docId }, "DeleteDocument gRPC handler error")
        callback({ code: grpc.status.INTERNAL, message: "internal error" })
      }
    },

    async PermissionChanged(
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>,
    ) {
      if (!authenticate(call)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, message: "unauthorized" })
      }

      const { doc_id, user_id, role } = call.request
      try {
        logger.debug("PermissionChanged called via gRPC")
        await changeUserPermission(String(doc_id), String(user_id), String(role))
        callback(null, {})
      } catch (err) {
        logger.error({ error: err, docId: doc_id }, "PermissionChanged gRPC handler error")
        callback({ code: grpc.status.INTERNAL, message: "internal error" })
      }
    },
  })

  const address = `0.0.0.0:${config.GRPC_PORT}`
  server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      logger.error({ error: err }, "Failed to bind gRPC server")
      return
    }
    logger.info({ port }, "Internal gRPC API listening")
  })

  return server
}
