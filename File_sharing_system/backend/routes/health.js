const express = require('express');
const client = require('prom-client');
const { pool } = require('../db/pool');
const redis = require('../services/redis');

const router = express.Router();

client.collectDefaultMetrics();
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status']
});

// Liveness — process is up, nothing more
router.get('/health', (req, res) => res.json({ status: 'ok' }));

// Readiness — dependencies are actually reachable
router.get('/ready', async (req, res) => {
  const checks = { postgres: false, redis: false };
  try {
    await pool.query('SELECT 1');
    checks.postgres = true;
  } catch {}
  try {
    await redis.ping();
    checks.redis = true;
  } catch {}
  const ready = Object.values(checks).every(Boolean);
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready', checks });
});

router.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

module.exports = { router, httpRequestDuration };
