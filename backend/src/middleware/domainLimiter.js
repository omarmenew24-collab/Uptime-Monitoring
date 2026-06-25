import redis from '../cache/redis.js';

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_PER_DOMAIN) || 5;
const SLOT_TTL_SECONDS = 30;

const keyFor = (domain) => `domain:limit:${domain}`;

export const acquireDomainSlot = async (domain) => {
  try {
    const key = keyFor(domain);
    const count = await redis.incr(key);
    await redis.expire(key, SLOT_TTL_SECONDS);

    if (count > MAX_CONCURRENT) {
      await redis.decr(key);
      return false;
    }

    return true;
  } catch {
    return true;
  }
};

export const releaseDomainSlot = async (domain) => {
  try {
    const key = keyFor(domain);
    const count = await redis.decr(key);
    if (count <= 0) await redis.del(key);
  } catch {
    // release failure is not fatal — TTL will clean up
  }
};
