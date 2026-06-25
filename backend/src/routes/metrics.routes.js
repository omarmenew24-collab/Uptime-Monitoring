import { Router } from 'express';
import { getMetrics } from '../services/metrics.service.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const metrics = await getMetrics();
    return res.status(200).json(metrics);
  } catch (err) {
    console.error('Metrics error:', err);
    return res.status(500).json({ error: 'Failed to gather metrics' });
  }
});

export default router;
