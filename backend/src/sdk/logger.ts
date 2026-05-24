import http from 'http';

export interface LLMLogPayload {
  conversationId: string;
  messageId?: string;
  model: string;
  provider: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestStatus: 'success' | 'error';
  errorMessage?: string | null;
  inputPreview: string;
  outputPreview: string;
}

/**
 * Lightweight SDK / Wrapper for logging LLM inference metadata.
 * Captures request and response metadata and sends it to the ingestion service asynchronously.
 */
export class LLMLoggerSDK {
  private ingestionUrl: string;

  constructor() {
    this.ingestionUrl = process.env.INGESTION_API_URL || 'http://localhost:5001/api/ingest';
  }

  /**
   * Estimates token count based on string length (heuristic fallback: ~4 characters per token)
   */
  public estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Sends inference log to the ingestion endpoint asynchronously.
   * This runs as a background task and will not block the main request execution.
   */
  public async logInference(payload: LLMLogPayload): Promise<void> {
    const data = JSON.stringify(payload);
    
    // We parse the URL manually to use Node's native http module to avoid external fetch dependency issues.
    try {
      const url = new URL(this.ingestionUrl);
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      };

      const req = http.request(options, (res) => {
        res.resume(); // Consume response data to free up memory
      });

      req.on('error', (err) => {
        console.error('[SDK Logger] Failed to send log to ingestion API:', err.message);
      });

      req.write(data);
      req.end();
    } catch (error: any) {
      console.error('[SDK Logger] Error formatting ingestion URL:', error.message);
    }
  }

  /**
   * Helper to execute and wrap an LLM call.
   * Measures latency, catches errors, counts tokens, and fires off the log.
   */
  public async wrapCall<T>(
    params: {
      conversationId: string;
      messageId?: string;
      model: string;
      provider: string;
      input: string;
    },
    llmFn: () => Promise<{ output: string; promptTokens?: number; completionTokens?: number }>
  ): Promise<string> {
    const startTime = performance.now();
    let output = '';
    let requestStatus: 'success' | 'error' = 'success';
    let errorMessage: string | undefined;
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      const result = await llmFn();
      output = result.output;
      promptTokens = result.promptTokens ?? this.estimateTokens(params.input);
      completionTokens = result.completionTokens ?? this.estimateTokens(output);
      return output;
    } catch (error: any) {
      requestStatus = 'error';
      errorMessage = error.message || String(error);
      throw error;
    } finally {
      const latencyMs = Math.round(performance.now() - startTime);
      const totalTokens = promptTokens + completionTokens;

      // Asynchronous non-blocking dispatch of log
      this.logInference({
        conversationId: params.conversationId,
        messageId: params.messageId,
        model: params.model,
        provider: params.provider,
        latencyMs,
        promptTokens,
        completionTokens,
        totalTokens,
        requestStatus,
        errorMessage,
        inputPreview: params.input,
        outputPreview: output,
      }).catch((err) => {
        console.error('[SDK Logger] Async log dispatch failed:', err);
      });
    }
  }
}

// Export a singleton SDK instance
export const sdkLogger = new LLMLoggerSDK();
