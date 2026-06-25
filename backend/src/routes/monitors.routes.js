import { Router } from 'express';
import { createMonitorSchema, updateMonitorSchema } from '../schemas/monitors.schema.js';
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
    if (err.statusCode === 403) {
      return res.status(403).json({ error: err.message });
    }
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

router.patch('/:id', async (req, res) => {
  const parsed = updateMonitorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
  }

  try {
    const monitor = await monitorsService.editMonitor(req.params.id, req.user.id, parsed.data);
    if (!monitor) {
      return res.status(404).json({ error: 'Monitor not found' });
    }
    return res.status(200).json({ data: monitor });
  } catch (err) {
    console.error('Edit monitor error:', err);
    return res.status(500).json({ error: 'Failed to update monitor' });
  }
});

router.patch('/:id/pause', async (req, res) => {
  try {
    const result = await monitorsService.pause(req.params.id, req.user.id);
    if (!result) {
      return res.status(404).json({ error: 'Monitor not found' });
    }
    return res.status(200).json({ data: result });
  } catch (err) {
    console.error('Pause monitor error:', err);
    return res.status(500).json({ error: 'Failed to pause monitor' });
  }
});

router.patch('/:id/resume', async (req, res) => {
  try {
    const result = await monitorsService.resume(req.params.id, req.user.id);
    if (!result) {
      return res.status(404).json({ error: 'Monitor not found' });
    }
    return res.status(200).json({ data: result });
  } catch (err) {
    console.error('Resume monitor error:', err);
    return res.status(500).json({ error: 'Failed to resume monitor' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await monitorsService.remove(req.params.id, req.user.id);
    if (!result) {
      return res.status(404).json({ error: 'Monitor not found' });
    }
    return res.status(204).end();
  } catch (err) {
    console.error('Delete monitor error:', err);
    return res.status(500).json({ error: 'Failed to delete monitor' });
  }
});

export default router;
