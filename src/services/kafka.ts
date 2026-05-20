import { Kafka, Producer, Message, Partitioners, Consumer } from "kafkajs"
import { config } from "../config/config.js"
import { logger } from "./logger.js"
import { KafkaNotificationMessage } from "../types/kafka.js"
import { changeUserPermission } from "../core/users.js"
import { deleteDocument } from "../core/documents.js"

class KafkaService {
  private producer: Producer | null = null
  private consumer: Consumer | null = null
  public producerConnected: boolean = false
  private consumerRunning: boolean = false

  private TOPICS = [
    "notification-events"
  ]
  constructor() {
    logger.debug({ brokers: config.KAFKA_BROKERS }, "Init Kafka")
    if (!config.KAFKA_BROKERS) {
      logger.info("Kafka Brokers not found")
      return
    }
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
    if (!this.producer) {
      logger.info("[Kafka] Producer not connected")
      return
    }
    try {
      await this.producer.connect()
      this.producerConnected = true
      logger.info("[Kafka] Producer connected successfully")
    } catch (error) {
      logger.error({ error }, "[Kafka] Error connecting producer")
      throw new Error("Failed to start Producer")
    }
  }

  private async startConsumer(): Promise<void> {
    if (!this.consumer) {
      logger.info("[Kafka] Consumer not connected")
      return
    }
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
    if (!this.producer) return
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

  private async handleMessage(): Promise<void> {
    if (!this.consumer) return
    await this.consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }: { topic: string; partition: number; message: Message }) => {
        if (!message.value) return

        try {
          switch (topic) {
            case "notification-events":
              {
                const payload: KafkaNotificationMessage = JSON.parse(message.value.toString())
                logger.trace({ topic, partition, payload }, "[Kafka] Received notification message")

                switch (payload.type) {
                  case "document.role_updated":
                    {
                      const updated = await changeUserPermission(
                        payload.document_id,
                        Number(payload.affected_user_id),
                        String(payload.role)
                      )
                      logger.trace({ updated }, "Notification sent on role updated")
                    }
                    break
                  case "document.deleted":
                    {
                      const updated = await deleteDocument(
                        payload.document_id,
                      )
                      logger.trace({ updated }, "Notification sent when document deleted")
                    }
                    break
                  default:
                    logger.warn({ topic, payload }, "[Kafka] Unknown type on topic")
                    return
                }
              }
              break
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
    if (this.producer) await this.producer.disconnect()
    if (this.consumer) await this.consumer.disconnect()
  }
}

export const kafkaService = new KafkaService()
