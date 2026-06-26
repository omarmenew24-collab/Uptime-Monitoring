import { Router } from 'express';
import * as usersService from '../services/users.service.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const settings = await usersService.getUserSettings(req.user.id);
    if (!settings) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.status(200).json({ data: settings });
  } catch (err) {
    console.error('Get settings error:', err);
    return res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.patch('/', async (req, res) => {
  try {
    const settings = await usersService.updateUserSettings(req.user.id, req.body);
    if (!settings) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.status(200).json({ data: settings });
  } catch (err) {
    if (err.statusCode === 400) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Update settings error:', err);
    return res.status(500).json({ error: 'Failed to update settings' });
  }
});

export default router;
