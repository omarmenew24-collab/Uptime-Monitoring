import { Router } from 'express';
import { getPublicStatus } from '../services/status.service.js';

const router = Router();

router.get('/:userId', async (req, res) => {
  try {
    const status = await getPublicStatus(req.params.userId);
    if (!status) {
      return res.status(404).json({ error: 'Status page not found' });
    }
    return res.status(200).json({ data: status });
  } catch (err) {
    console.error('Status page error:', err);
    return res.status(500).json({ error: 'Failed to load status page' });
  }
});

export default router;
