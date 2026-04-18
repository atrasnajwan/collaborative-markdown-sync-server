import { Kafka, Producer, Message, Partitioners } from "kafkajs"
import { config } from "../config/config.js"
import { logger } from "./logger.js"

class KafkaService {
  private producer: Producer

  constructor() {
    const kafka = new Kafka({
      clientId: "collaborative-markdown",
      brokers: config.KAFKA_BROKERS,
    })

    this.producer = kafka.producer({
      createPartitioner: Partitioners.LegacyPartitioner,
    })
  }

  public async start(): Promise<void> {
    try {
      await this.producer.connect()
      logger.info("[Kafka] Producer connected successfully")
    } catch (error) {
      logger.error({ error }, "[Kafka] Error connecting producer")
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

  public async shutdown(): Promise<void> {
    await this.producer.disconnect()
  }
}

export const kafkaService = new KafkaService()
