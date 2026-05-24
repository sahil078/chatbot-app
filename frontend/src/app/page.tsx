'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Plus,
  MessageSquare,
  Send,
  Gauge,
  Activity,
  XCircle,
  AlertTriangle,
  Database,
  Cpu,
  Clock,
  RefreshCw
} from 'lucide-react';

interface Conversation {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  _count?: {
    messages: number;
  };
}

interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

interface MetricSummary {
  totalRequests: number;
  avgLatencyMs: number;
  totalTokens: number;
  errorRatePercent: number;
}

interface ProviderStat {
  provider: string;
  count: number;
  avgLatencyMs: number;
}

interface LogEntry {
  id: string;
  model: string;
  provider: string;
  latencyMs: number;
  totalTokens: number;
  requestStatus: string;
  createdAt: string;
  errorMessage?: string;
  inputPreview: string;
  outputPreview: string;
}

interface TimelinePoint {
  time: string;
  latency: number;
  tokens: number;
  status: string;
}

interface DashboardMetrics {
  summary: MetricSummary;
  providerStats: ProviderStat[];
  timeline: TimelinePoint[];
  recentLogs: LogEntry[];
}

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:5001';

export default function ChatDashboardPage() {
  // Sidebar & Chat State
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [provider, setProvider] = useState('mock');
  const [model, setModel] = useState('mock-gpt');
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeStreamingText, setActiveStreamingText] = useState('');

  // Dashboard Metrics State
  const [metrics, setMetrics] = useState<DashboardMetrics>({
    summary: { totalRequests: 0, avgLatencyMs: 0, totalTokens: 0, errorRatePercent: 0 },
    providerStats: [],
    timeline: [],
    recentLogs: [],
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeStreamReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  // Sync model selection based on provider
  useEffect(() => {
    if (provider === 'gemini') {
      setModel('gemini-2.5-flash');
    } else {
      setModel('mock-gpt-4');
    }
  }, [provider]);

  // Load conversations on mount
  useEffect(() => {
    fetchConversations();
    fetchMetrics();
    // Poll metrics every 4 seconds to get real-time statistics
    const metricsInterval = setInterval(fetchMetrics, 4000);
    return () => clearInterval(metricsInterval);
  }, []);

  // Scroll to bottom of chat when messages or streaming text changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeStreamingText]);

  const fetchConversations = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/conversations`);
      if (res.ok) {
        const data = await res.json();
        setConversations(data);
        // Set first conversation as active if none is selected
        if (data.length > 0 && !activeConversation) {
          handleSelectConversation(data[0]);
        }
      }
    } catch (err) {
      console.error('Error fetching conversations:', err);
    }
  };

  const fetchMetrics = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/dashboard/metrics`);
      if (res.ok) {
        const data = await res.json();
        setMetrics(data);
      }
    } catch (err) {
      console.error('Error fetching metrics:', err);
    }
  };

  const handleSelectConversation = async (conv: Conversation) => {
    try {
      // If switching, cancel active stream first
      if (isStreaming) {
        await cancelActiveStream();
      }

      setActiveConversation(conv);
      setActiveStreamingText('');

      const res = await fetch(`${BACKEND_URL}/api/conversations/${conv.id}/messages`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages);
      }
    } catch (err) {
      console.error('Error fetching conversation messages:', err);
    }
  };

  const createNewChat = async () => {
    try {
      if (isStreaming) {
        await cancelActiveStream();
      }

      const res = await fetch(`${BACKEND_URL}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `Chat Session #${conversations.length + 1}` }),
      });

      if (res.ok) {
        const newConv = await res.json();
        setConversations((prev) => [newConv, ...prev]);
        setActiveConversation(newConv);
        setMessages([]);
        setActiveStreamingText('');
      }
    } catch (err) {
      console.error('Create chat error:', err);
    }
  };

  const cancelActiveStream = async () => {
    if (!activeConversation) return;

    // 1. Cancel on Client reader side
    if (activeStreamReaderRef.current) {
      try {
        await activeStreamReaderRef.current.cancel();
      } catch (e) {
        console.error('Error cancelling stream reader:', e);
      }
      activeStreamReaderRef.current = null;
    }

    // 2. Notify backend to trigger API/LLM abort
    try {
      await fetch(`${BACKEND_URL}/api/conversations/${activeConversation.id}/cancel`, {
        method: 'POST',
      });
    } catch (err) {
      console.error('Cancel backend request error:', err);
    }

    setIsStreaming(false);
    setActiveStreamingText('');
    fetchConversations();
    fetchMetrics();
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !activeConversation || isStreaming) return;

    const userPrompt = input.trim();
    setInput('');
    setIsStreaming(true);
    setActiveStreamingText('');

    // Append local user message immediately
    const tempUserMessage: Message = {
      id: Math.random().toString(),
      conversationId: activeConversation.id,
      role: 'user',
      content: userPrompt,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMessage]);

    try {
      const response = await fetch(`${BACKEND_URL}/api/conversations/${activeConversation.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model, prompt: userPrompt }),
      });

      if (!response.ok) {
        throw new Error(`Failed to establish connection: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Readable stream not supported');
      }

      activeStreamReaderRef.current = reader;
      const decoder = new TextDecoder();
      let buffer = '';

      let assistantMessageId = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');

        // Save the last partial line back to the buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.replace('data: ', '').trim();
            if (!dataStr) continue;

            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.type === 'init') {
                assistantMessageId = parsed.assistantMessageId;
              } else if (parsed.type === 'chunk') {
                setActiveStreamingText((prev) => prev + parsed.text);
              } else if (parsed.type === 'done') {
                // Final full text received
                const finalMsg: Message = {
                  id: assistantMessageId || Math.random().toString(),
                  conversationId: activeConversation.id,
                  role: 'assistant',
                  content: parsed.fullText,
                  createdAt: new Date().toISOString(),
                };
                setMessages((prev) => [...prev, finalMsg]);
                setActiveStreamingText('');
              } else if (parsed.type === 'error') {
                throw new Error(parsed.error);
              }
            } catch (e) {
              console.error('Error parsing SSE line:', e, line);
            }
          }
        }
      }
    } catch (error: any) {
      console.error('Chat generation failed:', error);
      // Append fallback error bubble if stream was interrupted
      const errorMsg: Message = {
        id: Math.random().toString(),
        conversationId: activeConversation.id,
        role: 'assistant',
        content: error.message || 'Streaming response interrupted.',
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsStreaming(false);
      setActiveStreamingText('');
      activeStreamReaderRef.current = null;
      fetchConversations();
      fetchMetrics();
    }
  };

  return (
    <div className="app-container">
      <div className="ambient-glow-1"></div>
      <div className="ambient-glow-2"></div>

      {/* Sidebar: Chat Management */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="logo-icon">Æ</div>
          <h1 className="app-title">Aether Log</h1>
        </div>

        <button className="new-chat-btn" onClick={createNewChat}>
          <Plus size={18} /> New Conversation
        </button>

        <div className="provider-selector-container">
          <div className="selector-label">LLM Provider</div>
          <select
            className="custom-select"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            disabled={isStreaming}
          >
            <option value="mock">Simulated Mock Model</option>
            <option value="gemini">Gemini API</option>
          </select>
          <div className="selector-label" style={{ marginTop: '8px' }}>Model Spec</div>
          <input
            type="text"
            className="custom-select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={isStreaming}
            style={{ fontSize: '0.85rem' }}
          />
        </div>

        <div className="conversation-list">
          <div className="selector-label">Recent Chats</div>
          {conversations.length === 0 ? (
            <div style={{ padding: '12px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              No chats found. Create one above!
            </div>
          ) : (
            conversations.map((conv) => (
              <div
                key={conv.id}
                className={`conversation-item ${activeConversation?.id === conv.id ? 'active' : ''}`}
                onClick={() => handleSelectConversation(conv)}
              >
                <div className="conversation-info">
                  <span className="conversation-name">{conv.title}</span>
                  <div className="conversation-meta">
                    <span className={`status-badge ${conv.status}`}></span>
                    <span>{conv.status}</span>
                    <span>•</span>
                    <span>{conv._count?.messages || 0} messages</span>
                  </div>
                </div>
                <MessageSquare size={14} style={{ color: 'var(--text-muted)' }} />
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Main Workspace (Chat Center + Ingestion Dashboard Right) */}
      <main className="workspace">
        {/* Chat Section */}
        <section className="chat-section">
          <header className="chat-header">
            <div className="chat-header-info">
              {activeConversation ? (
                <>
                  <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem' }}>{activeConversation.title}</h2>
                  <span className={`active-chat-status ${activeConversation.status}`}>
                    {activeConversation.status}
                  </span>
                </>
              ) : (
                <h2>Select a Chat</h2>
              )}
            </div>

            {isStreaming && (
              <button className="cancel-chat-btn" onClick={cancelActiveStream}>
                <XCircle size={16} /> Cancel Generation
              </button>
            )}
          </header>

          <div className="messages-viewport">
            {!activeConversation ? (
              <div className="empty-chat-state">
                <div className="empty-icon">
                  <MessageSquare size={32} />
                </div>
                <h3>Welcome to Aether Chat</h3>
                <p>Choose an existing session on the sidebar or click "New Conversation" to start streaming logs.</p>
              </div>
            ) : messages.length === 0 && !activeStreamingText ? (
              <div className="empty-chat-state">
                <div className="empty-icon">
                  <Send size={32} style={{ color: 'var(--secondary)' }} />
                </div>
                <h3>Start the Conversation</h3>
                <p>Send a message below. Try writing standard text or test PII redaction like <strong>john.doe@example.com</strong> or phone number <strong>+1-555-0199</strong>!</p>
              </div>
            ) : (
              <>
                {messages.map((msg) => (
                  <div key={msg.id} className={`message-bubble ${msg.role}`}>
                    <div className="message-avatar">
                      {msg.role === 'user' ? 'You' : `${provider.toUpperCase()} Assistant`}
                    </div>
                    <div>{msg.content}</div>
                  </div>
                ))}

                {isStreaming && activeStreamingText && (
                  <div className="message-bubble assistant">
                    <div className="message-avatar">{provider.toUpperCase()} Assistant</div>
                    <div>
                      {activeStreamingText}
                      <span className="streaming-pulse"></span>
                    </div>
                  </div>
                )}
              </>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="chat-input-container">
            <form onSubmit={sendMessage} className="chat-input-wrapper">
              <input
                type="text"
                className="chat-input"
                placeholder={
                  !activeConversation
                    ? "Please select or create a conversation first..."
                    : isStreaming
                      ? "Assistant is writing..."
                      : "Message chatbot... (type /error to test error states)"
                }
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={!activeConversation || isStreaming}
              />
              <button
                type="submit"
                className="send-btn"
                disabled={!activeConversation || isStreaming || !input.trim()}
              >
                <Send size={18} />
              </button>
            </form>
          </div>
        </section>

        {/* Ingestion & Inference Dashboard (Right Panel) */}
        <section className="dashboard-section">
          <header className="dashboard-header">
            <Gauge size={20} style={{ color: 'var(--primary)' }} />
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem' }}>Inference Pipeline</h2>
            <div style={{ flex: 1 }} />
            <button onClick={fetchMetrics} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
              <RefreshCw size={14} className={isStreaming ? 'animate-spin' : ''} />
            </button>
          </header>

          <div className="dashboard-grid">
            {/* Metric Value Cards */}
            <div className="metrics-row">
              <div className="metric-card latency">
                <div className="metric-header">
                  <span className="metric-title">Avg Latency</span>
                  <Clock size={16} className="metric-icon" />
                </div>
                <div className="metric-value">{metrics.summary.avgLatencyMs} <span style={{ fontSize: '1rem', fontWeight: 500 }}>ms</span></div>
                <div className="metric-subtext">Avg response wait</div>
              </div>

              <div className="metric-card throughput">
                <div className="metric-header">
                  <span className="metric-title">Throughput</span>
                  <Activity size={16} className="metric-icon" />
                </div>
                <div className="metric-value">{metrics.summary.totalRequests}</div>
                <div className="metric-subtext">Total tracked requests</div>
              </div>
            </div>

            <div className="metrics-row">
              <div className="metric-card errors">
                <div className="metric-header">
                  <span className="metric-title">Error Rate</span>
                  <AlertTriangle size={16} className="metric-icon" />
                </div>
                <div className="metric-value">{metrics.summary.errorRatePercent} <span style={{ fontSize: '1rem', fontWeight: 500 }}>%</span></div>
                <div className="metric-subtext">Failed API connections</div>
              </div>

              <div className="metric-card tokens">
                <div className="metric-header">
                  <span className="metric-title">Total Tokens</span>
                  <Cpu size={16} className="metric-icon" />
                </div>
                <div className="metric-value">
                  {metrics.summary.totalTokens >= 1000000
                    ? `${(metrics.summary.totalTokens / 1000000).toFixed(1)}M`
                    : metrics.summary.totalTokens >= 1000
                      ? `${(metrics.summary.totalTokens / 1000).toFixed(1)}k`
                      : metrics.summary.totalTokens}
                </div>
                <div className="metric-subtext">Calculated usage size</div>
              </div>
            </div>

            {/* Timeline Mini Chart */}
            <div className="chart-container">
              <div className="chart-header-title">Response Latency History (Recent Calls)</div>
              {metrics.timeline.length === 0 ? (
                <div style={{ height: '120px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  Awaiting database logs...
                </div>
              ) : (
                <div className="chart-bars-wrapper">
                  {metrics.timeline.map((point, index) => {
                    // Normalize bar height relative to max value
                    const maxVal = Math.max(...metrics.timeline.map(p => p.latency), 1000);
                    const pct = Math.min((point.latency / maxVal) * 100, 100);
                    return (
                      <div key={index} className="chart-bar-container">
                        <div
                          className={`chart-bar ${point.status === 'error' ? 'failed' : ''}`}
                          style={{ height: `${Math.max(pct, 5)}%` }}
                        >
                          <div className="bar-tooltip">
                            {point.latency}ms ({point.tokens} tokens) @ {point.time}
                          </div>
                        </div>
                        <span className="chart-axis-label">{point.time.split(':')[2]}s</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Ingestion Stream Logs */}
            <div className="chart-container">
              <div className="chart-header-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Database size={14} style={{ color: 'var(--success)' }} />
                Real-Time Database Ingest
              </div>
              <div className="recent-logs-list">
                {metrics.recentLogs.length === 0 ? (
                  <div style={{ padding: '20px', textAlign: 'center', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    No ingest payloads processed yet.
                  </div>
                ) : (
                  metrics.recentLogs.map((log) => (
                    <div key={log.id} className="log-item-row">
                      <div className="log-row-header">
                        <span className="log-model">{log.provider.toUpperCase()} ({log.model})</span>
                        <span className={`log-status ${log.requestStatus}`}>
                          {log.requestStatus}
                        </span>
                      </div>
                      <div className="log-details-grid">
                        <div>
                          <span className="log-label">Latency: </span>
                          <span className="log-value">{log.latencyMs}ms</span>
                        </div>
                        <div>
                          <span className="log-label">Tokens: </span>
                          <span className="log-value">{log.totalTokens}</span>
                        </div>
                        <div>
                          <span className="log-label">Redacted: </span>
                          <span className="log-value">Yes</span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
