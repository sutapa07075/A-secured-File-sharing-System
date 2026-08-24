require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');

const logger = require('./utils/logger');
const { generalLimiter } = require('./middleware/rateLimit');
const authRoutes = require('./routes/auth');
const documentRoutes = require('./routes/documents');
const zkKeyRoutes = require('./routes/zkKeys');
const zkDocumentRoutes = require('./routes/zkDocuments');
const { router: healthRoutes } = require('./routes/health');
const { pool } = require('./db/pool');

const app = express();
const PORT = process.env.PORT || 4000;

// --- Security headers ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", process.env.FRONTEND_ORIGIN],
      imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com'],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  },
  crossOriginResourcePolicy: { policy: 'same-site' }
}));
app.use(helmet.hsts({ maxAge: 31536000, includeSubDomains: true, preload: true }));

app.use(cors({ origin: process.env.FRONTEND_ORIGIN, credentials: true }));
app.use(cookieParser());
app.use(pinoHttp({ logger }));
app.use(generalLimiter);

// NOTE: raw body (not json-parsed) is used for the streaming upload endpoints
// so we can pipe/encrypt bytes directly — see routes/documents.js. Those routes
// apply their own raw-body parsers (express.raw / direct req.pipe). JSON parsing
// is applied to everything else.
const RAW_BODY_ROUTES = [
  /^\/api\/documents\/upload$/,
  /^\/api\/documents\/upload\/[^/]+\/chunk$/,
  /^\/api\/zk\/documents$/
];
app.use((req, res, next) => {
  if (RAW_BODY_ROUTES.some((re) => re.test(req.path))) return next();
  express.json({ limit: '2mb' })(req, res, next);
});

// --- Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/zk', zkKeyRoutes);
app.use('/api/zk', zkDocumentRoutes);
app.use('/', healthRoutes);

// --- 404 + error handling ---
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  req.log?.error(err);
  res.status(err.status || 500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
});

const server = app.listen(PORT, () => {
  logger.info(`Secure Doc Share API listening on :${PORT}`);
});

// --- Graceful shutdown ---
async function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);
  server.close(async () => {
    try {
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
  // force-exit if graceful shutdown hangs
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
