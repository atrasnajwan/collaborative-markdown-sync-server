export type DocumentUpdateDTO = {
  seq: number
  binary: string // base64-encoded bytes
}

export type DocumentState = {
  snapshot: string // base64
  snapshot_seq: number
  updates: DocumentUpdateDTO[]
}
