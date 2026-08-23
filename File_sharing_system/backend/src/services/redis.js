const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false
});

redis.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Redis connection error', err.message);
});

module.exports = redis;
