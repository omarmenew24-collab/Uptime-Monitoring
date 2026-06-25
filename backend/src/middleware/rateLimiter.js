import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import redis from '../cache/redis.js';

const MAX_REQUESTS = Number(process.env.API_RATE_LIMIT) || 100;

export const apiRateLimiter = rateLimit({
  windowMs: 60_000,
  max: MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
  }),
  message: { error: `Rate limit exceeded. Max ${MAX_REQUESTS} requests per minute.` },
});
