const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.access_token', '*.refresh_token', '*.wrappedDek'],
  formatters: {
    level(label) {
      return { level: label };
    }
  }
});

module.exports = logger;
