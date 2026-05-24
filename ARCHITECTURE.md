# Architecture Notes

This document describes the architectural layout, core systems, telemetry logging strategies, failure scenarios, and scaling considerations for the **Aether Inference Logger & Chatbot System**.

---

## 1. Component Topology

The system uses a decoupled monorepo architecture consisting of four containerized services managed by Docker Compose:

```
                                  +-----------------------+
                                  |    Next.js Client     |
                                  | (Chat & Telemetry DB) |
                                  +-----------+-----------+
                                              |
                                              | (1) Chat Stream / History
                                              v
                                  +-----------+-----------+
                                  |  Express.js Backend   |
                                  +-----+-----------+-----+
                                        |           |
                     (2) LLM API Call   |           | (3) Async Log Dispatch
                   (Gemini/Mock LLM)    |           |     (LLM Logger SDK)
                                        v           v
                                 +------+--+   +----+-----+
                                 | LLM APIs|   | Ingest   |
                                 +---------+   | Endpoint |
                                               +----+-----+
                                                    |
                                                    | (4) LPUSH Event
                                                    v
                                               +----+-----+
                                               |  Redis   |
                                               |  Queue   |
                                               +----+-----+
                                                    |
                                                    | (5) BRPOP Worker Loop
                                                    v
                                               +----+-----+
                                               | Logging  |
                                               |  Worker  |
                                               +----+-----+
                                                    |
                                                    | (6) Redact PII & Save
                                                    v
                                               +----+-----+
                                               |  Postgres|
                                               | Database |
                                               +----------+
```

### Key Services
* **Next.js Frontend (Port 3000)**: Serves the React user interface. Handles chat sessions (starting, listing, and resuming) and streams responses using a zero-dependency SSE stream decoder. Runs a background timer that polls backend telemetry metrics to render live charts.
* **Express.js Backend (Port 5001)**: Exposes APIs for chat handling, conversation session persistence, and log ingestion. Hosts the lightweight logging SDK and runs the background Redis queue worker.
* **Redis (Port 6379)**: Acts as the high-throughput, event-based ingestion queue broker.
* **PostgreSQL (Port 5432)**: Serves as the relational database for persistent storage, managed via Prisma ORM.

---

## 2. Ingestion Flow (Step-by-Step)

The log ingestion pipeline is designed to be **non-blocking** for the conversational thread, ensuring database write latencies never delay message deliveries.

1. **Inference Trigger**: The user submits a message. The backend registers the request and initializes a Server-Sent Events (SSE) connection with the browser.
2. **Execution Wrapping**: The backend calls the LLM (Gemini or Mock) through the **LLM SDK Logger**. The SDK wraps the LLM execution block, starting a high-resolution timer (`performance.now()`).
3. **Response Streaming**: Response text chunks are streamed to the user's browser chunk-by-chunk in real time. At the same time, the server buffers the text segments in memory.
4. **Log Collection**: When the stream completes, the wrapper computes the exact elapsed latency, calculates the input and output token counts, and invokes the SDK's `logInference` method.
5. **Asynchronous Dispatch**: The SDK fires an asynchronous HTTP `POST /api/ingest` request. It does this as a background promise without holding up the SSE connection response.
6. **Ingestion Endpoint**: The `/api/ingest` route validates the incoming JSON against a strict `Zod` validation schema. Once validated, it pushes the log string into Redis using `LPUSH llm:logs:queue` and immediately returns a `202 Accepted` status to the SDK.
7. **Queue Worker**: A background loop running in the Express service blocks on Redis using `BRPOP llm:logs:queue 0`. When a log is received:
   * It parses the payload.
   * It runs the **PII Redaction Engine** on both the input and output text previews.
   * It persists the sanitized metadata log into PostgreSQL.

---

## 3. Telemetry Logging Strategy

We developed a custom **Lightweight SDK (`backend/src/sdk/logger.ts`)** that encapsulates LLM execution blocks.

### Design Principles
* **Non-Blocking Operation**: Telemetry logs are dispatched out-of-band. The primary chat handler does not block on log transmission or database insertion.
* **Loose Coupling**: The SDK targets a generic ingestion endpoint URL. If needed, the ingestion API could be migrated to a completely separate server or microservice without changing a single line of SDK implementation code.
* **Accurate Telemetry**:
  * **Latency**: Measured using high-resolution node timers (`performance.now()`), representing the true end-to-end model execution time.
  * **Token Estimation**: Real LLM calls return actual token usage. For simulated models or fallbacks, the SDK falls back to a standard word-length heuristic (`charCount / 4`) to ensure logs remain uniform.
  * **Errors**: Unhandled promise rejections or API timeouts are caught by the SDK, flagged as `requestStatus: "error"`, and the exception message is saved for debugging.

---

## 4. PII Redaction Engine

Privacy filters are applied inside the **Queue Worker** right before database insertion. This ensures:
1. The user receives their **raw, unredacted response** in the chat bubble (necessary for developer utility).
2. The telemetry database contains **only redacted logs**, ensuring compliance with data privacy regulations (GDPR, HIPAA).

### Redaction Rules
Sensitive parameters are searched using optimized Regular Expressions:
* **Emails**: Replaced with `[REDACTED_EMAIL]`
* **Phone Numbers**: Replaced with `[REDACTED_PHONE]`
* **Credit Cards**: Replaced with `[REDACTED_CARD]`
* **Social Security Numbers (SSN)**: Replaced with `[REDACTED_SSN]`
* **High-Entropy Keys**: Replaced with `[REDACTED_KEY]` (detects OpenAI/Gemini/AWS API keys and Bearer tokens).

---

## 5. Scaling Considerations

As request throughput scales to millions of logging payloads daily, the following design decisions help maintain efficiency:

### A. Redis Buffering
Database writing is the main bottleneck. Putting Redis in front of PostgreSQL acts as a write buffer, absorbing high bursts of traffic. If database write speeds saturate, logs pile up safely in Redis memory without impacting the API server's memory footprint.

### B. Database Index Optimization
We have added indexes on key search and aggregation fields inside `schema.prisma`:
* `InferenceLog.createdAt`: Used to scope timeline chart requests to the last 24 hours.
* `InferenceLog.provider`: Speed up queries that group performance metrics by provider.
* `InferenceLog.conversationId`: Speed up querying history logs by session.

### C. Horizontally Scaling Ingestion
In a production cloud environment:
1. The Express ingestion endpoint and the background Queue Worker can be separated into distinct deployment modules. 
2. The API workers can scale horizontally (behind a load balancer) to handle millions of ingest requests.
3. For enterprise throughput, Redis lists can be replaced with **Apache Kafka** or **AWS SQS** to enable distributed partitioning.

---

## 6. Failure Handling Assumptions

### Scenario A: Database is Unavailable
* **Impact**: The Express API can still serve chat conversations (since it uses memory cache streams).
* **Behavior**: The SDK successfully receives logs and pushes them to Redis. Since Redis persists the queue in memory, logs stack up safely. The Queue Worker will continuously log database connection errors and retry. Once PostgreSQL is back online, the worker processes the stacked logs sequentially.

### Scenario B: Redis is Unavailable
* **Impact**: The worker cannot poll events, and the API cannot enqueue events.
* **Behavior**: The SDK contains a fallback hook. If the SDK fails to connect or POST to the ingestion queue, it catches the exception and attempts to save the log record **directly** to the database via Prisma client. This keeps logging operational during queue downtime, at the cost of slightly higher API response times.

### Scenario C: Chat Stream Disconnects (Cancellation)
* **Impact**: User closes the tab or clicks "Cancel" mid-generation.
* **Behavior**: The server intercepts the client abort event (or `/cancel` POST) and immediately calls `.abort()` on the corresponding Node AbortController. The active connection to the LLM API is aborted. The SDK calculates latency up to the point of cancellation, compiles the partial response text generated so far, and logs the request status as `cancelled`.
