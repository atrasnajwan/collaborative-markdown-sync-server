import { Kafka, Producer, Message, Partitioners, Consumer } from "kafkajs"
import { config } from "../config/config.js"
import { logger } from "./logger.js"
import { KafkaNotificationMessage } from "../types/kafka.js"
import { changeUserPermission } from "../core/users.js"

class KafkaService {
  private producer: Producer
  private consumer: Consumer | null = null
  private consumerRunning = false

  private TOPICS = [
    "notification-events"
  ]
  constructor() {
    const kafka = new Kafka({
      clientId: "collaborative-markdown",
      brokers: config.KAFKA_BROKERS,
    })

    this.producer = kafka.producer({
      createPartitioner: Partitioners.LegacyPartitioner,
    })

    this.consumer = kafka.consumer({
      groupId: "sync-server-consumer",
      allowAutoTopicCreation: true
    })
  }

  public start(): Promise<[void, void]> {
    return Promise.all([
      this.startProducer(),
      this.startConsumer()
    ])
  }

  public async startProducer(): Promise<void> {
    try {
      await this.producer.connect()
      logger.info("[Kafka] Producer connected successfully")
    } catch (error) {
      logger.error({ error }, "[Kafka] Error connecting producer")
      throw new Error("Failed to start Producer")
    }
  }

  private async startConsumer(): Promise<void> {
    if (!this.consumer) return
    if (this.consumerRunning) {
      logger.warn("[Kafka] Consumer already running")
      return
    }

    try {
      await this.consumer.connect()
      this.consumerRunning = true
      logger.info("[Kafka] Consumer connected successfully")

      // Subscribe to the topics
      await this.consumer.subscribe({
        topics: this.TOPICS,
        fromBeginning: false,
      })

      await this.handleMessage()
    } catch (error) {
      logger.error({ error }, "[Kafka] Error connecting consumer")
      throw new Error("Failed to start Consumer")
    }
  }

  public async sendMessage(topic: string, messages: Message[]): Promise<void> {
    try {
      await this.producer.send({
        topic,
        messages,
      })
      logger.debug({ length: messages.length, topic }, "[Kafka] Message sent")
    } catch (error) {
      logger.error({ error }, "[Kafka] Error sending message")
    }
  }

  private async handleMessage():   Promise<void> {
    await this.consumer?.run({
      autoCommit: false, 
      eachMessage: async ({ topic, partition, message }: { topic: string; partition: number; message: Message }) => {
        if (!message.value) return

        try {
          switch (topic) {
            case "notification-events":
              { const payload: KafkaNotificationMessage = JSON.parse(message.value.toString())
              logger.debug({ topic, partition, payload }, "[Kafka] Received notification message")
              
              switch (payload.type) {
                case "document.role_updated":
                  { const updated = await changeUserPermission(
                    String(payload.document_id),
                    String(payload.affected_user_id),
                    payload.role
                  )
                  logger.debug({ updated }, "Notification sent")
                  break }
                default:
                  logger.warn({ topic, payload }, "[Kafka] Unknown type on topic")
                  return
              } 
              break }
            default:
              logger.warn({ topic }, "[Kafka] Unknown topic")
              return
          }
        } catch (error) {
          logger.error(
            { error, topic, partition, message: message.value.toString() },
            "[Kafka] Failed to process message"
          )
        }
        // TODO: commit message
        // this.consumer?.commitOffsets([
        //   { topic, partition, offset: (BigInt(message.partition.off) + 1n).toString() }
        // ])
      },
    })
  }

  public async shutdown(): Promise<void> {
    await this.producer.disconnect()
    if (this.consumer) {
      await this.consumer.disconnect()
    }
  }
}

export const kafkaService = new KafkaService()
