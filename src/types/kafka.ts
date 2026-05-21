export interface KafkaDocMessage {
  event_id: string
  type: string
  document_id: number
  user_id?: number
  timestamp: number
  data: string
}

export interface KafkaNotificationMessage {
  event_id: string
  type: string
  document_id: number
  affected_user_id?: number
  timestamp: number
  role?: string
}

