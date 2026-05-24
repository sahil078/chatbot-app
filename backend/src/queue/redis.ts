import Redis from 'ioredis';
import { prisma } from '../db/prisma';
import { redactPII } from '../services/pii';
import { LLMLogPayload } from '../sdk/logger';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const QUEUE_NAME = 'llm:logs:queue';

// Publisher Redis connection
export const redisPublisher = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

// Worker Redis connection (needs separate connection because BRPOP blocks the connection)
const redisWorker = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

redisPublisher.on('error', (err) => console.error('[Redis Publisher] connection error:', err));
redisWorker.on('error', (err) => console.error('[Redis Worker] connection error:', err));

/**
 * Push an LLM log entry to the queue for asynchronous processing.
 */
export async function pushLogToQueue(payload: LLMLogPayload): Promise<void> {
  try {
    await redisPublisher.lpush(QUEUE_NAME, JSON.stringify(payload));
  } catch (error) {
    console.error('[Redis Ingestion Queue] Failed to push log to queue:', error);
    // Fallback: save directly to db to prevent log loss if Redis is down
    await saveLogToDatabase(payload);
  }
}

/**
 * Save log payload to PostgreSQL database, applying PII redaction.
 */
async function saveLogToDatabase(payload: LLMLogPayload): Promise<void> {
  const redactedInput = redactPII(payload.inputPreview);
  const redactedOutput = redactPII(payload.outputPreview);

  try {
    await prisma.inferenceLog.create({
      data: {
        conversationId: payload.conversationId,
        messageId: payload.messageId || null,
        model: payload.model,
        provider: payload.provider,
        latencyMs: payload.latencyMs,
        promptTokens: payload.promptTokens,
        completionTokens: payload.completionTokens,
        totalTokens: payload.totalTokens,
        requestStatus: payload.requestStatus,
        errorMessage: payload.errorMessage || null,
        inputPreview: redactedInput,
        outputPreview: redactedOutput,
      },
    });
  } catch (error) {
    console.error('[Database Storage] Error writing inference log:', error);
  }
}

/**
 * The event worker loop that consumes logging events from Redis BRPOP.
 */
export async function startQueueWorker(): Promise<void> {
  console.log('[Queue Worker] Logging worker started, listening for events...');

  while (true) {
    try {
      // BRPOP blocks connection until an item is available.
      // Returns [key, value] where key is queue name and value is the pushed string.
      const result = await redisWorker.brpop(QUEUE_NAME, 0);

      if (result) {
        const [_, value] = result;
        const payload: LLMLogPayload = JSON.parse(value);
        
        await saveLogToDatabase(payload);
      }
    } catch (error) {
      console.error('[Queue Worker] Error processing log queue event:', error);
      // Wait a moment before retrying in case of continuous error states
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
