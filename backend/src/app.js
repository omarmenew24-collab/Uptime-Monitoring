import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { clerkMiddleware } from '@clerk/express';
import { handleClerkWebhook } from './routes/webhooks.js';
import { requireAuth, syncUser } from './middleware/auth.js';
import { apiRateLimiter } from './middleware/rateLimiter.js';
import monitorsRouter from './routes/monitors.routes.js';
import metricsRouter from './routes/metrics.routes.js';
import statusRouter from './routes/status.routes.js';
import usersRouter from './routes/users.routes.js';
import { query } from './config/db.js';
import redis from './cache/redis.js';

const app = express();

app.use(helmet());
app.use(cors({
  origin: [
    'https://uptime-monitoring-eight.vercel.app',
    'http://localhost:5173',
  ],
  credentials: true,
}));
app.use(clerkMiddleware());

app.post('/api/webhooks/clerk', express.raw({ type: 'application/json' }), handleClerkWebhook);

app.use(express.json());

app.get('/api/ping', (req, res) => res.send('ok'));

app.get('/api/health', async (req, res) => {
  let redisOk = false;
  let pgOk = false;

  try { redisOk = (await redis.ping()) === 'PONG'; } catch { /* */ }
  try { await query('SELECT 1'); pgOk = true; } catch { /* */ }

  const status = redisOk && pgOk ? 'healthy' : 'unhealthy';
  const code = status === 'healthy' ? 200 : 503;

  res.status(code).json({ status, redis: redisOk, postgres: pgOk });
});

app.use('/api/metrics', metricsRouter);
app.use('/api/status', statusRouter);

app.use('/api/', apiRateLimiter);

app.use('/api/monitors', requireAuth, syncUser, monitorsRouter);
app.use('/api/settings', requireAuth, syncUser, usersRouter);

export default app;
