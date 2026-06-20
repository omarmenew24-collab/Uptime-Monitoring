import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { clerkMiddleware } from '@clerk/express';
import { handleClerkWebhook } from './routes/webhooks.js';
import { requireAuth, syncUser } from './middleware/auth.js';
import monitorsRouter from './routes/monitors.routes.js';

const app = express();

app.use(helmet());
app.use(cors());
app.use(clerkMiddleware());

app.post('/api/webhooks/clerk', express.raw({ type: 'application/json' }), handleClerkWebhook);

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/monitors', requireAuth, syncUser, monitorsRouter);

export default app;
