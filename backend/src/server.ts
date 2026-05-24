import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { apiRouter } from './routes/api';
import { startQueueWorker } from './queue/redis';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

// CORS setup to allow communication with Next.js frontend
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());

// Main router mounting
app.use('/api', apiRouter);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', timestamp: new Date() });
});

// Start server
app.listen(PORT, () => {
  console.log(`[Server] Express server running on port ${PORT}`);
  
  // Start the background Redis ingestion queue worker
  startQueueWorker().catch((err) => {
    console.error('[Server] Failed to start background queue worker:', err);
  });
});
