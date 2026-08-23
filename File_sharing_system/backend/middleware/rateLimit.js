const rateLimit = require('express-rate-limit');
const redis = require('../services/redis');

/** Minimal Redis store for express-rate-limit v7 (avoids pulling in an extra package). */
class RedisStore {
  constructor(prefix) {
    this.prefix = prefix;
  }
  async increment(key) {
    const redisKey = `${this.prefix}:${key}`;
    const count = await redis.incr(redisKey);
    if (count === 1) await redis.expire(redisKey, 60);
    const ttl = await redis.ttl(redisKey);
    return { totalHits: count, resetTime: new Date(Date.now() + ttl * 1000) };
  }
  async decrement(key) {
    await redis.decr(`${this.prefix}:${key}`);
  }
  async resetKey(key) {
    await redis.del(`${this.prefix}:${key}`);
  }
}

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // 120 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore('rl:general')
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // tighter limit on login/token endpoints to blunt credential stuffing
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore('rl:auth')
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore('rl:upload')
});

module.exports = { generalLimiter, authLimiter, uploadLimiter };
