import { Router } from 'express';
import { createMonitorSchema } from '../schemas/monitors.schema.js';
import * as monitorsService from '../services/monitors.service.js';

const router = Router();

router.post('/', async (req, res) => {
  const parsed = createMonitorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
  }

  try {
    const monitor = await monitorsService.createMonitor(req.user.id, parsed.data);
    return res.status(201).json({ data: monitor });
  } catch (err) {
    console.error('Create monitor error:', err);
    return res.status(500).json({ error: 'Failed to create monitor' });
  }
});

router.get('/', async (req, res) => {
  try {
    const monitors = await monitorsService.getMonitorsByUser(req.user.id);
    return res.status(200).json({ data: monitors });
  } catch (err) {
    console.error('Get monitors error:', err);
    return res.status(500).json({ error: 'Failed to fetch monitors' });
  }
});

export default router;
