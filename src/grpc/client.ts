import { setGrpcAuth } from "../core/auth.js"
import grpc from "@grpc/grpc-js"
import protoLoader from "@grpc/proto-loader"
import { config } from "../config/config.js"
import { DocumentState, DocumentUpdateDTO } from "../types/document.js"
import { toBase64 } from "../utils/utils.js"
import { UserRoleResponse } from "../types/user.js"
import { ServiceClient } from "@grpc/grpc-js/build/src/make-client.js"

interface SyncClientPackage extends grpc.GrpcObject {
  internalpb: {
    InternalService: grpc.ServiceClientConstructor
  }
}
interface DocumentStateResponse {
  snapshot: Buffer
  snapshot_seq: number
  updates: DocumentUpdateResponse[]
}

interface DocumentUpdateResponse {
  seq: number
  binary: Buffer
}

interface DocumentUpdateRequest {
  doc_id: number
  user_id?: number
  update: Buffer
}

type ClientType = ServiceClient | null

let grpcClient: ClientType = null

export function useGrpc(): boolean {
  return !!config.BACKEND_API_GRPC_ADDRESS
}

export function ensureGrpcClient(): ClientType {
  if (grpcClient || !useGrpc()) return grpcClient

  // load proto definition dynamically. using URL relative to this file so it continues
  // to work after the project is compiled into `dist/`.
  const PROTO_PATH = new URL("../proto/client.proto", import.meta.url).pathname
  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  })

  const grpcObj = grpc.loadPackageDefinition(packageDef) as SyncClientPackage
  const InternalService = grpcObj.internalpb.InternalService
  grpcClient = new InternalService(
    config.BACKEND_API_GRPC_ADDRESS,
    grpc.credentials.createInsecure(),
  )
  return grpcClient
}

function makeMetadata(): grpc.Metadata {
  const meta = new grpc.Metadata()
  // auth
  return setGrpcAuth(meta)
}

export function getDocumentState(docId: string): Promise<DocumentState> {
  return new Promise((resolve, reject) => {
    ensureGrpcClient()?.GetDocumentState(
      { id: Number(docId) },
      makeMetadata(),
      (err: grpc.ServiceError | null, resp: DocumentStateResponse) => {
        if (err) return reject(err)
        const updates: DocumentUpdateDTO[] = (resp.updates || []).map((u: DocumentUpdateResponse) => ({
          seq: u.seq,
          binary: toBase64(u.binary),
        }))
        resolve({
          snapshot: toBase64(resp.snapshot),
          snapshot_seq: resp.snapshot_seq,
          updates,
        })
      },
    )
  })
}

export function createDocumentUpdate(
  docId: string,
  update: Uint8Array,
  userId?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req: DocumentUpdateRequest = {
      doc_id: Number(docId),
      update: Buffer.from(update),
    }
    if (userId) {
      req.user_id = Number(userId)
    }
    ensureGrpcClient()?.CreateUpdate(req, makeMetadata(), (err: grpc.ServiceError | null) => {
      if (err) return reject(err)
      resolve()
    })
  })
}

export function createDocumentSnapshot(docId: string, state: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    ensureGrpcClient()?.CreateSnapshot(
      { doc_id: Number(docId), snapshot: Buffer.from(state) },
      makeMetadata(),
      (err: grpc.ServiceError | null) => {
        if (err) return reject(err)
        resolve()
      },
    )
  })
}

export function getUserRole(docId: string, userId: string): Promise<UserRoleResponse> {
  return new Promise((resolve, reject) => {
    ensureGrpcClient()?.GetUserRole(
      { doc_id: Number(docId), user_id: Number(userId) },
      makeMetadata(),
      (err: grpc.ServiceError | null, resp: UserRoleResponse) => {
        if (err) return reject(err)
        resolve(resp)
      },
    )
  })
}
