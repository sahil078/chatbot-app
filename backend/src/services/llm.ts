import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { sdkLogger } from '../sdk/logger';

// In-memory registry to store active abort controllers for cancelling streams
export const activeStreams = new Map<string, AbortController>();

/**
 * Interface representing a chat message for context
 */
interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Handles LLM interaction for real (Gemini, OpenAI) and Mock providers.
 * Tracks latency, performs token estimation, and integrates the SDK logging wrapper.
 */
export class LLMService {
  private openai: OpenAI | null = null;
  private genAI: GoogleGenerativeAI | null = null;

  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    if (process.env.GEMINI_API_KEY) {
      this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    }
  }

  /**
   * Main entry point to stream responses.
   */
  public async streamChat(params: {
    conversationId: string;
    messageId: string;
    provider: string;
    model: string;
    prompt: string;
    history: ChatMessage[];
    onChunk: (text: string) => void;
    onComplete: (fullText: string) => void;
    onError: (error: any) => void;
    signal: AbortSignal;
  }) {
    const { conversationId, messageId, provider, model, prompt, history, onChunk, onComplete, onError, signal } = params;
    const startTime = performance.now();
    let fullOutput = '';
    let requestStatus: 'success' | 'error' = 'success';
    let errorMessage: string | undefined;

    // Concat input history for token estimation
    const inputContent = history.map(h => `${h.role}: ${h.content}`).join('\n') + `\nuser: ${prompt}`;
    const promptTokens = sdkLogger.estimateTokens(inputContent);

    try {
      if (signal.aborted) {
        throw new Error('Stream cancelled by user');
      }

      if (provider === 'openai' && this.openai) {
        // OpenAI stream
        const messages = [
          ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' as const : 'user' as const, content: h.content })),
          { role: 'user' as const, content: prompt }
        ];

        const stream = await this.openai.chat.completions.create({
          model: model || 'gpt-4o-mini',
          messages,
          stream: true,
        }, { signal });

        for await (const chunk of stream) {
          if (signal.aborted) {
            throw new Error('Stream cancelled by user');
          }
          const text = chunk.choices[0]?.delta?.content || '';
          if (text) {
            fullOutput += text;
            onChunk(text);
          }
        }

      } else if (provider === 'gemini' && this.genAI) {
        // Gemini Stream
        const geminiModel = this.genAI.getGenerativeModel({ model: model || 'gemini-1.5-flash' });
        
        // Format history for Gemini API
        const contents = history.map(h => ({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content }]
        }));
        contents.push({ role: 'user', parts: [{ text: prompt }] });

        const result = await geminiModel.generateContentStream({
          contents,
        });

        for await (const chunk of result.stream) {
          if (signal.aborted) {
            throw new Error('Stream cancelled by user');
          }
          const text = chunk.text();
          if (text) {
            fullOutput += text;
            onChunk(text);
          }
        }

      } else {
        // Fallback or explicit Mock Provider
        await this.streamMockResponse({
          prompt,
          onChunk,
          signal,
          onFinish: (text) => {
            fullOutput = text;
          }
        });
      }

      // Finish successfully
      onComplete(fullOutput);

    } catch (error: any) {
      requestStatus = 'error';
      errorMessage = error.name === 'AbortError' || error.message?.includes('cancelled')
        ? 'Stream cancelled by user'
        : error.message || String(error);
      onError(error);
    } finally {
      // Calculate final stats
      const latencyMs = Math.round(performance.now() - startTime);
      const completionTokens = sdkLogger.estimateTokens(fullOutput);
      const totalTokens = promptTokens + completionTokens;

      // Dispatch to SDK Logger
      sdkLogger.logInference({
        conversationId,
        messageId,
        model,
        provider: this.openai && provider === 'openai' ? 'openai' : (this.genAI && provider === 'gemini' ? 'gemini' : 'mock'),
        latencyMs,
        promptTokens,
        completionTokens,
        totalTokens,
        requestStatus,
        errorMessage,
        inputPreview: prompt,
        outputPreview: fullOutput,
      }).catch(err => {
        console.error('[LLM Service] Failed to send inference log to SDK:', err);
      });
    }
  }

  /**
   * Helper to simulate streaming responses from a mock model.
   * Perfect for out-of-the-box local testing without API keys.
   */
  private streamMockResponse(params: {
    prompt: string;
    onChunk: (text: string) => void;
    signal: AbortSignal;
    onFinish: (text: string) => void;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      const { prompt, onChunk, signal, onFinish } = params;

      // Check for user-triggered error tests
      if (prompt.toLowerCase().includes('/error')) {
        return reject(new Error('Simulated API connection failure (Triggered by "/error" keyword)'));
      }

      // 5% random failure rate simulation for the errors dashboard
      if (Math.random() < 0.05) {
        return reject(new Error('Simulated random API timeout error (5% rate check)'));
      }

      const mockResponses = [
        "That is an interesting question! Let me explain. When building high-performance LLM ingestion architectures, it is crucial to decouple the ingestion endpoint from database writes using an event broker like Redis or Kafka. This ensures your chat thread remains responsive and latency is kept to a minimum.",
        "Hello! I am a simulated AI model. I can process your request in real time. Our pipeline will redact any PII you type (such as test@example.com or 555-0199) and store the metrics asynchronously.",
        "Sure! Here is a summary of design patterns: 1. Singleton pattern controls object creation. 2. Observer pattern manages subscription-like relationships. 3. Strategy pattern enables dynamic algorithm switching at runtime.",
        "According to our ingestion dashboard, we are monitoring token usage, query latency, and throughput (requests/min) to detect anomalies in real time. Let me know if you would like me to simulate more data!"
      ];

      // Pick a random mock response
      const chosenText = mockResponses[Math.floor(Math.random() * mockResponses.length)];
      const words = chosenText.split(' ');
      let currentWordIndex = 0;
      let accumulatedText = '';

      const intervalId = setInterval(() => {
        if (signal.aborted) {
          clearInterval(intervalId);
          reject(new Error('Stream cancelled by user'));
          return;
        }

        if (currentWordIndex >= words.length) {
          clearInterval(intervalId);
          onFinish(accumulatedText);
          resolve();
          return;
        }

        const word = words[currentWordIndex] + ' ';
        accumulatedText += word;
        onChunk(word);
        currentWordIndex++;
      }, 70); // Emit a word every 70ms to feel like a real streaming experience
    });
  }
}

export const llmService = new LLMService();
