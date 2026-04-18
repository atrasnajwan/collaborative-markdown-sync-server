export interface KafkaDocMessage {
  event_id: string
  type: string
  document_id: Number
  user_id?: Number
  timestamp: Number
  data: string
}
