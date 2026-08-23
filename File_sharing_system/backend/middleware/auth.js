const jwt = require('jsonwebtoken');

/** Requires a valid access-token JWT in the Authorization header or __session cookie. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies?.access_token;

  if (!token) {
    return res.status(401).json({ error: 'Missing access token' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Optional auth: attaches req.user if present, but doesn't block anonymous share-link viewers. */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies?.access_token;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.user = { id: payload.sub, email: payload.email };
  } catch {
    // ignore invalid token for optional auth
  }
  next();
}

module.exports = { requireAuth, optionalAuth };
