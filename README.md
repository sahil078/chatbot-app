# Aether Inference Logger & Chatbot System

A lightweight, real-time inference logging and ingestion platform built for LLM applications. Featuring multi-provider support (Gemini, OpenAI, and Simulated Mock), live latency/error telemetry dashboards, PII redaction, background queue ingestion (via Redis), PostgreSQL database persistence, and one-command Docker setup.

---

## Architecture Overview

This application follows a decoupled monorepo structure consisting of a **Next.js Frontend** and an **Express.js Backend** coordinating via a **Redis Queue** and a **PostgreSQL Database**.

```
                         +-----------------------+
                         |    Next.js Client     |
                         | (Chat & Telemetry DB) |
                         +-----------+-----------+
                                     |
                                     | (1) Chat / Abort / History
                                     v
                         +-----------+-----------+
                         |  Express.js Backend   |
                         +-----+-----------+-----+
                               |           |
            (2) LLM API Call   |           | (3) Async Log Dispatch
          (Gemini/OpenAI/Mock) |           |     (LLM Logger SDK)
                               v           v
                        +------+--+   +----+-----+
                        | LLM APIs|   | Ingest   |
                        +---------+   | Endpoint |
                                      +----+-----+
                                           |
                                           | (4) Event Push
                                           v
                                      +----+-----+
                                      |  Redis   |
                                      |  Queue   |
                                      +----+-----+
                                           |
                                           | (5) BRPOP Fetch
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

### Ingestion Flow & Queue Architecture
1. **Interception**: When a chat request is processed by the server, the LLM SDK wrapper wraps the execution. It tracks the start timestamp.
2. **Streaming**: As response chunks stream to the client via Server-Sent Events (SSE), they are also accumulated in server memory.
3. **Log Dispatch**: As soon as the stream finishes (or fails/cancels), the SDK computes overall latency, estimates token consumption, formats the payload, and sends an asynchronous HTTP POST request to the `/api/ingest` endpoint.
4. **Queue Buffering**: The `/api/ingest` route validates the payload structure using `Zod` and publishes the event to a Redis list (`llm:logs:queue`). This is a fire-and-forget operation, meaning the API responds immediately with a `202 Accepted` status, decoupling client-facing API latency from DB write speed.
5. **Worker Persistence**: A background worker thread polls Redis using a blocking pop (`BRPOP`). It consumes log payloads, performs regex-based PII redaction on inputs/outputs, and saves the sanitized log into the PostgreSQL database.

---

## Folder Structure

```
chat-bot/
├── docker-compose.yml           # Runs Postgres, Redis, Backend, Frontend
├── README.md                    # Project Documentation
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── prisma/
│   │   └── schema.prisma        # Prisma DB schema definitions
│   └── src/
│       ├── server.ts            # Entry point for Express server
│       ├── db/
│       │   └── prisma.ts        # Shared Prisma client
│       ├── sdk/
│       │   └── logger.ts        # Inference metadata tracking SDK
│       ├── queue/
│       │   └── redis.ts         # Redis connection & background logs worker
│       ├── services/
│       │   ├── llm.ts           # Gemini, OpenAI & Mock LLM managers
│       │   └── pii.ts           # RegEx PII redaction utilities
│       └── routes/
│           └── api.ts           # Chat, cancel, history & dashboard endpoints
└── frontend/
    ├── Dockerfile
    ├── package.json
    ├── tsconfig.json
    └── src/
        └── app/
            ├── layout.tsx       # Root layout (Fonts, Meta)
            ├── globals.css      # Custom styling (HSL dark glass theme)
            └── page.tsx         # Dashboard layout, state, stream reader
```

---

## Schema Design Decisions

We chose PostgreSQL for log persistence due to its relational safety, rich indexing capabilities, and structured querying support needed for dashboard analytics.

### Tables
1. **`Conversation`**: Stores session data.
   - `id` (UUID, Primary Key): Unique session ID.
   - `title` (String): Session topic/name.
   - `status` (String): Tracks if a conversation is `active`, `cancelled`, or `completed`.
   - `createdAt` / `updatedAt` (DateTime).
2. **`Message`**: Stores conversation threads.
   - `id` (UUID, Primary Key)
   - `conversationId` (Foreign Key -> `Conversation.id` on Cascade Delete)
   - `role` (String): `user`, `assistant`, or `system`.
   - `content` (String): Plain text message.
   - `createdAt` (DateTime)
3. **`InferenceLog`**: Stores telemetry metadata separate from chat flow.
   - `id` (UUID, Primary Key)
   - `conversationId` (Foreign Key -> `Conversation.id` on Cascade Delete)
   - `messageId` (Foreign Key -> `Message.id`, Nullable): Direct reference to the generated message.
   - `model` / `provider` (String): Specifies model version (e.g. `gemini-1.5-flash`) and provider (e.g. `gemini`).
   - `latencyMs` (Int): Overall roundtrip model request time.
   - `promptTokens` / `completionTokens` / `totalTokens` (Int): Token counts.
   - `requestStatus` (String): `success` or `error`.
   - `errorMessage` (String, Nullable): If request failed, stores error message.
   - `inputPreview` / `outputPreview` (String): **Redacted** previews of inputs and responses.

### Tradeoffs
* **Previews vs. Chat Content**: We keep the `InferenceLog` separate from the `Message` history. This creates minor duplication (`inputPreview` is related to user message, `outputPreview` is assistant response) but allows the `InferenceLog` table to be partitioned or archived separately for analytics without breaking the user-facing chat window history.
* **Token Estimations**: Real APIs provide token details, but mock fallbacks do not. We use a character-length-based heuristic (`chars / 4`) as a standard approximation fallback to represent token counts uniformly.

---

## PII Redaction Strategy

PII (Personally Identifiable Information) is redacted in the worker pipeline before logs are committed to the database. We filter:
* **Emails**: `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}` -> `[REDACTED_EMAIL]`
* **Phone Numbers**: Commonly structured numbers -> `[REDACTED_PHONE]`
* **Credit Cards**: 13-16 digit numbers -> `[REDACTED_CARD]`
* **SSNs**: US SSN format (`XXX-XX-XXXX`) -> `[REDACTED_SSN]`
* **API Keys / Auth Tokens**: `sk-...` OpenAI keys or high-entropy credentials -> `[REDACTED_KEY]`

> [!TIP]
> Redaction happens in the background queue worker. This ensures that the user receives their raw, unredacted answers in the chat bubble in real time, but our database records remain compliant and clean of PII.

---

## Scaling & Failure Handling Considerations

### What happens if Redis goes down?
The SDK includes a retry fallback. If it fails to push to the Redis queue, it logs the exception and writes the log record **directly** to PostgreSQL via the Prisma client. This ensures zero data loss, though it temporarily shifts database workload to the API process.

### What happens if the Database goes down?
The Express API remains fully operational. Chat streams continue to function normally. Logs are dispatched to the SDK, which pushes them to Redis. Since Redis persists items in memory, logs stack up safely in the queue. Once the database recovers, the background worker processes the queued items and catches up.

### Database Optimizations for Scale
As inference logs grow into millions of rows:
1. **Indexes**: Added B-Tree indexes on `InferenceLog.createdAt`, `InferenceLog.provider`, and `InferenceLog.conversationId` to speed up dashboard charts and search functions.
2. **Partitioning**: Partition the `InferenceLog` table by month/day. Since metrics queries usually only target the last 24 hours, partitioning limits scans to the active day.
3. **Write Buffering**: To scale beyond single-node Redis lists, transition the queue broker to Kafka or AWS SQS, allowing log collection to scale horizontally independently of DB writers.

---

## Setup & Running the Application

### Prerequisites
* [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed on your machine.
* A `.env` file in the root workspace directory if you want to use real LLM APIs.

### Configuration
Create a `.env` file in the root directory (optional, fallback Mock provider will run automatically if empty):
```env
GEMINI_API_KEY=your_gemini_api_key
OPENAI_API_KEY=your_openai_api_key
```

### Launch Services
Open a terminal in the `chat-bot` directory and run:
```bash
docker-compose up --build
```

This starts:
1. **PostgreSQL** (`localhost:5432`)
2. **Redis** (`localhost:6379`)
3. **Backend API** (`localhost:5001`)
4. **Next.js Frontend** (`localhost:3000`)

---

## Features Demo Guide

Open [http://localhost:3000](http://localhost:3000) in your browser.

1. **Multi-turn Chatting**: Select `Simulated Mock Model` on the sidebar. Send a message, and watch the word-by-word streaming response. Send another message to test context.
2. **Cancelling Stream**: Send a long prompt, and immediately click the red **Cancel Generation** button in the chat header. The stream stops immediately, and the state changes to `cancelled`.
3. **Resuming Chats**: Click on "New Conversation" to create another chat session. Switch between recent conversations in the sidebar; historical messages will load instantly.
4. **Redaction Check**: Send a message containing an email address (e.g., `test@example.com`) or a credit card number. Observe that the chat bubble shows your text, but looking at the **Real-Time Database Ingest** table in the right dashboard panel shows that the log preview was redacted.
5. **Simulate Failures**: Type `/error` in the chat. The mock model will simulate a timeout error, which registers instantly on the **Error Rate** tile in the dashboard metrics.

---

## How to Share & Deploy the Application

If you need to share the application for testing or deploy it in a public environment, you can use the following strategies:

### 1. Easiest Sharing: GitHub + Docker Compose (Local Testing)
The absolute easiest way for another developer or tester to run your app is to share the GitHub repository:
1. Push the code to a GitHub repository (excluding the `.env` file as configured in `.gitignore`).
2. The tester clones the repository:
   ```bash
   git clone <your-repo-url>
   cd chat-bot
   ```
3. They create their own `.env` file with their `GEMINI_API_KEY`.
4. They run:
   ```bash
   docker compose up --build
   ```
This runs the entire stack locally on their computer exactly how it runs on yours, with zero configuration.

### 2. Cloud Deployment Options

#### Option A: VPS (DigitalOcean Droplet, AWS EC2, Hetzner) — **Recommended & Cost Effective**
Since the app is already containerized with Docker Compose, you can deploy it to a single Virtual Private Server (VPS) in under 10 minutes:
1. Provision a basic Linux VPS (Ubuntu).
2. Install Docker and Git on the server:
   ```bash
   sudo apt update
   sudo apt install docker.io docker-compose git -y
   ```
3. Clone your GitHub repository on the server.
4. Add the `.env` file with your `GEMINI_API_KEY` in the root folder.
5. In `docker-compose.yml`, change the frontend port from `3000:3000` to `80:3000` (or set up a reverse proxy like Nginx) so it is accessible on standard web ports.
6. Start the stack in background detached mode:
   ```bash
   docker compose up -d --build
   ```
7. Anyone can now test the app by visiting the public IP address of your server.

#### Option B: PaaS Platforms (Railway.app or Render.com) — **Easiest Deployment**
If you don't want to manage a server, platforms like Railway or Render can build and deploy the services directly from your GitHub repository:
1. Connect your GitHub account to **Railway** or **Render**.
2. Deploy a **PostgreSQL Database** and a **Redis Instance** through their UI (they provide these as managed services).
3. Deploy the `backend/` directory as a Web Service. Set environment variables (`DATABASE_URL`, `REDIS_URL`, `GEMINI_API_KEY`) pointing to the newly created database and Redis.
4. Deploy the `frontend/` directory as a Web Service, configuring `NEXT_PUBLIC_BACKEND_URL` to point to the backend service's URL.

#### Option C: Self-Hosted Kubernetes (k8s)
For large-scale enterprise deployments, you can deploy the app to Kubernetes:
1. Build the frontend and backend Docker images and push them to a container registry (Docker Hub, AWS ECR, or GitHub Container Registry).
2. Write Kubernetes deployment manifests or Helm charts defining:
   - StatefulSets for PostgreSQL and Redis.
   - Deployments for the frontend and backend.
   - Services and Ingress routing rules.
3. Apply the manifests to your self-hosted k8s cluster using `kubectl apply -f manifests/`.

