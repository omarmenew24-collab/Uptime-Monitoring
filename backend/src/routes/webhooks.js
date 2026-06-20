import { Webhook } from 'svix';
import { query } from '../config/db.js';

export const handleClerkWebhook = async (req, res) => {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  const wh = new Webhook(secret);
  let evt;

  try {
    evt = wh.verify(req.body, {
      'svix-id': req.headers['svix-id'],
      'svix-timestamp': req.headers['svix-timestamp'],
      'svix-signature': req.headers['svix-signature'],
    });
  } catch {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  if (evt.type === 'user.created') {
    const { id: clerkUserId, email_addresses } = evt.data;
    const email = email_addresses[0]?.email_address;

    try {
      // ON CONFLICT DO NOTHING makes this idempotent — safe for duplicate deliveries
      await query(
        'INSERT INTO users (clerk_user_id, email) VALUES ($1, $2) ON CONFLICT (clerk_user_id) DO NOTHING',
        [clerkUserId, email]
      );
    } catch (err) {
      console.error('Webhook insert error:', err);
      return res.status(500).json({ error: 'Failed to create user' });
    }
  }

  res.status(200).json({ received: true });
};
