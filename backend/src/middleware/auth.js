import { getAuth, clerkClient } from '@clerk/express';
import { query } from '../config/db.js';

export const requireAuth = (req, res, next) => {
  const { userId } = getAuth(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

export const syncUser = async (req, res, next) => {
  const { userId: clerkUserId } = getAuth(req);

  try {
    const result = await query(
      'SELECT * FROM users WHERE clerk_user_id = $1',
      [clerkUserId]
    );

    if (result.rows.length > 0) {
      req.user = result.rows[0];
      return next();
    }

    // Fallback: webhook hasn't arrived yet — fetch from Clerk and create the row
    const clerkUser = await clerkClient.users.getUser(clerkUserId);
    const email = clerkUser.emailAddresses[0]?.emailAddress;

    try {
      const insert = await query(
        'INSERT INTO users (clerk_user_id, email) VALUES ($1, $2) RETURNING *',
        [clerkUserId, email]
      );
      req.user = insert.rows[0];
    } catch (err) {
      // 23505 = unique_violation — concurrent insert beat us, just fetch the row
      if (err.code === '23505') {
        const retry = await query(
          'SELECT * FROM users WHERE clerk_user_id = $1',
          [clerkUserId]
        );
        req.user = retry.rows[0];
      } else {
        throw err;
      }
    }

    next();
  } catch (err) {
    console.error('syncUser error:', err);
    res.status(500).json({ error: 'Failed to sync user' });
  }
};
