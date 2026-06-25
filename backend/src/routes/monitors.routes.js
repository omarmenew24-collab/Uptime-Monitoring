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

router.get('/:id', async (req, res) => {
  try {
    const monitor = await monitorsService.getMonitorDetail(req.params.id, req.user.id);
    if (!monitor) {
      return res.status(404).json({ error: 'Monitor not found' });
    }
    return res.status(200).json({ data: monitor });
  } catch (err) {
    console.error('Get monitor detail error:', err);
    return res.status(500).json({ error: 'Failed to fetch monitor' });
  }
});

router.get('/:id/checks', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const checks = await monitorsService.getMonitorChecks(req.params.id, req.user.id, limit, offset);
    if (!checks) {
      return res.status(404).json({ error: 'Monitor not found' });
    }
    return res.status(200).json({ data: checks });
  } catch (err) {
    console.error('Get check logs error:', err);
    return res.status(500).json({ error: 'Failed to fetch check history' });
  }
});

export default router;
