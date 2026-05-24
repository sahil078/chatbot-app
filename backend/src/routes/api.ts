import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../db/prisma';
import { llmService, activeStreams } from '../services/llm';
import { pushLogToQueue } from '../queue/redis';

export const apiRouter = Router();

// Zod schema for ingestion payload validation
const IngestionPayloadSchema = z.object({
  conversationId: z.string(),
  messageId: z.string().optional(),
  model: z.string(),
  provider: z.string(),
  latencyMs: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  requestStatus: z.enum(['success', 'error']),
  errorMessage: z.string().optional().nullable(),
  inputPreview: z.string(),
  outputPreview: z.string(),
});

/**
 * 1. Create a new conversation
 */
apiRouter.post('/conversations', async (req: Request, res: Response) => {
  try {
    const { title } = req.body;
    const conversation = await prisma.conversation.create({
      data: {
        title: title || 'New Conversation',
        status: 'active',
      },
    });
    return res.status(201).json(conversation);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * 2. List all conversations
 */
apiRouter.get('/conversations', async (_req: Request, res: Response) => {
  try {
    const conversations = await prisma.conversation.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: {
          select: { messages: true }
        }
      }
    });
    return res.json(conversations);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * 3. Resume / Get conversation messages
 */
apiRouter.get('/conversations/:id/messages', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const conversation = await prisma.conversation.findUnique({
      where: { id },
    });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = await prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
    });

    return res.json({ conversation, messages });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * 4. Cancel an active conversation stream
 */
apiRouter.post('/conversations/:id/cancel', async (req: Request, res: Response) => {
  const { id } = req.params;
  const controller = activeStreams.get(id);

  if (controller) {
    controller.abort();
    activeStreams.delete(id);
    
    // Update status in DB
    await prisma.conversation.update({
      where: { id },
      data: { status: 'cancelled' }
    });

    return res.json({ message: 'Conversation generation cancelled' });
  }

  return res.status(400).json({ error: 'No active generation found for this conversation' });
});

/**
 * 5. Stream LLM Response (SSE)
 */
apiRouter.post('/conversations/:id/chat', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { provider, model, prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // 1. Confirm conversation exists
  const conversation = await prisma.conversation.findUnique({
    where: { id },
  });

  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  // 2. Generate UUIDs for messages
  const userMessageId = uuidv4();
  const assistantMessageId = uuidv4();

  try {
    // 3. Save User Message
    await prisma.message.create({
      data: {
        id: userMessageId,
        conversationId: id,
        role: 'user',
        content: prompt,
      },
    });

    // Get previous message history for context
    const previousMessages = await prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
      take: 10, // Maintain short conversational context
    });

    // 4. Set headers for Server-Sent Events (SSE)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // 5. Setup AbortController for cancellation
    const controller = new AbortController();
    activeStreams.set(id, controller);

    // Update conversation status back to active if it was cancelled
    await prisma.conversation.update({
      where: { id },
      data: { status: 'active' }
    });

    // Clean up registry on request close
    req.on('close', () => {
      if (activeStreams.has(id)) {
        console.log(`[HTTP Close] Connection closed by client. Aborting stream for conversation ${id}`);
        controller.abort();
        activeStreams.delete(id);
      }
    });

    // Send the message IDs to client first
    res.write(`data: ${JSON.stringify({ type: 'init', assistantMessageId, userMessageId })}\n\n`);

    // 6. Invoke LLM stream
    await llmService.streamChat({
      conversationId: id,
      messageId: assistantMessageId,
      provider,
      model,
      prompt,
      history: previousMessages.map(m => ({ role: m.role as any, content: m.content })),
      signal: controller.signal,
      onChunk: (text) => {
        res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
      },
      onComplete: async (fullText) => {
        activeStreams.delete(id);
        
        // Save Assistant Message
        await prisma.message.create({
          data: {
            id: assistantMessageId,
            conversationId: id,
            role: 'assistant',
            content: fullText,
          },
        });

        // Touch updatedAt on conversation
        await prisma.conversation.update({
          where: { id },
          data: { updatedAt: new Date(), status: 'completed' },
        });

        res.write(`data: ${JSON.stringify({ type: 'done', fullText })}\n\n`);
        res.end();
      },
      onError: async (error) => {
        activeStreams.delete(id);
        
        const isCancellation = controller.signal.aborted || error.message?.includes('cancelled');
        const errorContent = isCancellation 
          ? 'Generation cancelled by user.' 
          : `Error generating response: ${error.message || 'Unknown error'}`;

        // Save error/cancelled state as response message so conversation is continuous
        await prisma.message.create({
          data: {
            id: assistantMessageId,
            conversationId: id,
            role: 'assistant',
            content: errorContent,
          },
        });

        await prisma.conversation.update({
          where: { id },
          data: { status: isCancellation ? 'cancelled' : 'completed' }
        });

        res.write(`data: ${JSON.stringify({ type: 'error', error: errorContent })}\n\n`);
        res.end();
      },
    });

  } catch (error: any) {
    console.error('[Chat Router] Stream establishment error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * 6. Ingestion Endpoint
 */
apiRouter.post('/ingest', async (req: Request, res: Response) => {
  try {
    const validated = IngestionPayloadSchema.parse(req.body);
    
    // Push directly to Redis queue
    await pushLogToQueue(validated);

    return res.status(202).json({ status: 'queued' });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    return res.status(500).json({ error: error.message });
  }
});

/**
 * 7. Live Metrics Dashboard endpoint
 */
apiRouter.get('/dashboard/metrics', async (_req: Request, res: Response) => {
  try {
    const totalLogs = await prisma.inferenceLog.count();
    const successLogs = await prisma.inferenceLog.count({ where: { requestStatus: 'success' } });
    const errorLogs = await prisma.inferenceLog.count({ where: { requestStatus: 'error' } });

    // Aggregate overall numbers
    const aggregates = await prisma.inferenceLog.aggregate({
      _avg: {
        latencyMs: true,
      },
      _sum: {
        totalTokens: true,
      },
    });

    const avgLatency = Math.round(aggregates._avg.latencyMs || 0);
    const totalTokens = aggregates._sum.totalTokens || 0;
    const errorRate = totalLogs > 0 ? parseFloat(((errorLogs / totalLogs) * 100).toFixed(2)) : 0;

    // Get log distribution by provider
    const providerDistribution = await prisma.inferenceLog.groupBy({
      by: ['provider'],
      _count: {
        id: true,
      },
      _avg: {
        latencyMs: true,
      },
    });

    // Get 10 recent logs for dashboard table
    const recentLogs = await prisma.inferenceLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        model: true,
        provider: true,
        latencyMs: true,
        totalTokens: true,
        requestStatus: true,
        createdAt: true,
        errorMessage: true,
        inputPreview: true,
        outputPreview: true,
      }
    });

    // Generate timeline (last 10 aggregated records) for graph
    const logsForTimeline = await prisma.inferenceLog.findMany({
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: {
        createdAt: true,
        latencyMs: true,
        totalTokens: true,
        requestStatus: true,
      }
    });

    // Format timeline for easy chart parsing
    const timeline = logsForTimeline.map((l) => ({
      time: l.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      latency: l.latencyMs,
      tokens: l.totalTokens,
      status: l.requestStatus,
    }));

    return res.json({
      summary: {
        totalRequests: totalLogs,
        avgLatencyMs: avgLatency,
        totalTokens,
        errorRatePercent: errorRate,
      },
      providerStats: providerDistribution.map(p => ({
        provider: p.provider,
        count: p._count.id,
        avgLatencyMs: Math.round(p._avg.latencyMs || 0),
      })),
      timeline,
      recentLogs,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});
