import IORedis from 'ioredis';

const CHANNEL = 'monitor:events';

export const createPublisher = () => {
  const client = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  client.on('error', (err) => {
    console.error('Event publisher Redis error:', err.message);
  });

  const publish = async (event) => {
    try {
      await client.publish(CHANNEL, JSON.stringify(event));
    } catch {
      // publishing failure is not fatal — alert flag is already set in Postgres
    }
  };

  return { publish, close: () => client.quit() };
};

export const createSubscriber = (handler) => {
  const client = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  client.on('error', (err) => {
    console.error('Event subscriber Redis error:', err.message);
  });

  client.subscribe(CHANNEL).catch((err) => {
    console.error('Failed to subscribe to event channel:', err.message);
  });

  client.on('message', async (channel, message) => {
    if (channel !== CHANNEL) return;
    try {
      const event = JSON.parse(message);
      await handler(event);
    } catch (err) {
      console.error('Event handler error:', err.message);
    }
  });

  return { close: () => client.quit() };
};
