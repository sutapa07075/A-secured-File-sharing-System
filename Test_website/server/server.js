require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const validator = require('validator');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;

const db = require('./db');
const classesRouter = require('./routes/classes');
const testsRouter = require('./routes/tests');
const submissionsRouter = require('./routes/submissions');
const adminRouter = require('./routes/admin');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_TIMEOUT_MS = (parseInt(process.env.SESSION_TIMEOUT_MINUTES, 10) || 15) * 60 * 1000;

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 64) {
  console.error(
    '\nFATAL: ENCRYPTION_KEY is missing or invalid in .env (must be a 64-char hex string).\n' +
    'Generate one with:\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n'
  );
  process.exit(1);
}

// ---------- Security middleware ----------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
}));
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Global rate limiter (basic DoS protection)
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// Stricter limiter for auth endpoints (brute-force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

// ---------- Session (with rolling inactivity timeout) ----------
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: __dirname }),
  name: 'sid',
  secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
  resave: false,
  saveUninitialized: false,
  rolling: true, // refresh expiry on every request -> real inactivity timeout
  cookie: {
    httpOnly: true,
    secure: IS_PROD,       // requires HTTPS in production
    sameSite: 'lax',
    maxAge: SESSION_TIMEOUT_MS,
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// ---------- Passport (de)serialization ----------
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await db.get('SELECT id, email, name, provider, avatar_url, role FROM users WHERE id = ?', [id]);
    done(null, user || false);
  } catch (err) {
    done(err);
  }
});

// ---------- Google OAuth ----------
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_ID !== 'your_google_client_id') {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL,
  passReqToCallback: true,
  }, async (req, accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails && profile.emails[0] && profile.emails[0].value;
      if (!email) return done(new Error('Google account has no email'));
      const avatarUrl = profile.photos && profile.photos[0] && profile.photos[0].value;
      const requestedRole = ['student', 'teacher'].includes(req.query.state) ? req.query.state : 'student';

      let user = await db.get('SELECT * FROM users WHERE provider = ? AND provider_id = ?', ['google', profile.id]);
      if (!user) {
        // Link by email if a local account already exists, otherwise create new.
        user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (user) {
          await db.run('UPDATE users SET provider_id = ?, avatar_url = ? WHERE id = ?', [profile.id, avatarUrl, user.id]);
        } else {
          const info = await db.run(
            'INSERT INTO users (email, name, provider, provider_id, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)',
            [email, profile.displayName, 'google', profile.id, avatarUrl, requestedRole]
          );
          user = await db.get('SELECT * FROM users WHERE id = ?', [info.lastID]);
        }
      }
      return done(null, user);
    } catch (err) {
      console.error('[Google OAuth] Failed to sign in / register user:', err);
      return done(err);
    }
  }));
  console.log('[OAuth] Google strategy enabled.');
} else {
  console.log('[OAuth] Google strategy disabled (GOOGLE_CLIENT_ID not set in .env).');
}

// ---------- GitHub OAuth ----------
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_ID !== 'your_github_client_id') {
  passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: process.env.GITHUB_CALLBACK_URL,
  passReqToCallback: true,
  }, async (req, accessToken, refreshToken, profile, done) => {
    try {
      const email = (profile.emails && profile.emails[0] && profile.emails[0].value) || `${profile.username}@users.noreply.github.com`;
      const avatarUrl = profile.photos && profile.photos[0] && profile.photos[0].value;
      const requestedRole = ['student', 'teacher'].includes(req.query.state) ? req.query.state : 'student';

      let user = await db.get('SELECT * FROM users WHERE provider = ? AND provider_id = ?', ['github', profile.id]);
      if (!user) {
        user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (user) {
          await db.run('UPDATE users SET provider_id = ?, avatar_url = ? WHERE id = ?', [profile.id, avatarUrl, user.id]);
        } else {
          const info = await db.run(
            'INSERT INTO users (email, name, provider, provider_id, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)',
            [email, profile.displayName || profile.username, 'github', profile.id, avatarUrl, requestedRole]
          );
          user = await db.get('SELECT * FROM users WHERE id = ?', [info.lastID]);
        }
      }
      return done(null, user);
    } catch (err) {
      console.error('[GitHub OAuth] Failed to sign in / register user:', err);
      return done(err);
    }
  }));
  console.log('[OAuth] GitHub strategy enabled.');
} else {
  console.log('[OAuth] GitHub strategy disabled (GITHUB_CLIENT_ID not set in .env).');
}

// ---------- Password policy (shared with frontend) ----------
// At least 6 chars, 1 uppercase, 1 number, 1 special character.
function validatePassword(password) {
  const rules = {
    length: typeof password === 'string' && password.length >= 6,
    uppercase: /[A-Z]/.test(password || ''),
    number: /[0-9]/.test(password || ''),
    special: /[^A-Za-z0-9]/.test(password || ''),
  };
  const valid = Object.values(rules).every(Boolean);
  return { valid, rules };
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_TIME_MS = 15 * 60 * 1000;

// ---------- Local register ----------
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { email, password, name, role } = req.body || {};

    if (!email || !validator.isEmail(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }
    const { valid, rules } = validatePassword(password);
    if (!valid) {
      return res.status(400).json({ error: 'Password does not meet the required rules.', rules });
    }
    const finalRole = ['student', 'teacher'].includes(role) ? role : 'student';

    const existing = await db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const hash = bcrypt.hashSync(password, 12);
    const info = await db.run(
      'INSERT INTO users (email, password_hash, name, provider, role) VALUES (?, ?, ?, ?, ?)',
      [email.toLowerCase(), hash, name || null, 'local', finalRole]
    );

    const user = await db.get('SELECT id, email, name, provider, role FROM users WHERE id = ?', [info.lastID]);

    req.login(user, (err) => {
      if (err) return res.status(500).json({ error: 'Registered, but automatic login failed. Please log in.' });
      return res.status(201).json({ user });
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- Local login ----------
app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);

    // Generic message to avoid leaking which accounts exist.
    const genericError = 'Incorrect email or password.';

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: genericError });
    }

    if (user.lock_until && user.lock_until > Date.now()) {
      const minutesLeft = Math.ceil((user.lock_until - Date.now()) / 60000);
      return res.status(423).json({ error: `Account temporarily locked due to failed attempts. Try again in ${minutesLeft} minute(s).` });
    }

    const match = bcrypt.compareSync(password, user.password_hash);
    if (!match) {
      const attempts = user.failed_login_attempts + 1;
      let lockUntil = null;
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        lockUntil = Date.now() + LOCK_TIME_MS;
      }
      await db.run('UPDATE users SET failed_login_attempts = ?, lock_until = ? WHERE id = ?', [attempts, lockUntil, user.id]);
      return res.status(401).json({ error: genericError });
    }

    // Success: reset failed attempts.
    await db.run('UPDATE users SET failed_login_attempts = 0, lock_until = NULL WHERE id = ?', [user.id]);

    const safeUser = { id: user.id, email: user.email, name: user.name, provider: user.provider, role: user.role };
    req.login(safeUser, (err) => {
      if (err) return res.status(500).json({ error: 'Login failed. Please try again.' });
      return res.json({ user: safeUser });
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- Current user / session check ----------
app.get('/api/me', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ user: req.user, expiresInMs: req.session.cookie.maxAge });
  }
  return res.status(401).json({ error: 'Not authenticated.' });
});

// ---------- Logout ----------
app.post('/api/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.clearCookie('sid');
      res.json({ message: 'Logged out.' });
    });
  });
});

const GOOGLE_ENABLED = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_ID !== 'your_google_client_id');
const GITHUB_ENABLED = !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_ID !== 'your_github_client_id');

// ---------- Google OAuth routes ----------
app.get('/auth/google', (req, res, next) => {
  if (!GOOGLE_ENABLED) return res.redirect('/login.html?error=google_not_configured');
  next();
}, (req, res, next) => {
  const role = ['student', 'teacher'].includes(req.query.role) ? req.query.role : 'student';
  passport.authenticate('google', { scope: ['profile', 'email'], state: role })(req, res, next);
});
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login.html?error=google_failed' }),
  (req, res) => res.redirect(req.user.role === 'teacher' ? '/teacher-dashboard.html' : '/dashboard.html')
);

// ---------- GitHub OAuth routes ----------
app.get('/auth/github', (req, res, next) => {
  if (!GITHUB_ENABLED) return res.redirect('/login.html?error=github_not_configured');
  next();
}, (req, res, next) => {
  const role = ['student', 'teacher'].includes(req.query.role) ? req.query.role : 'student';
  passport.authenticate('github', { scope: ['user:email'], state: role })(req, res, next);
});
app.get('/auth/github/callback',
  passport.authenticate('github', { failureRedirect: '/login.html?error=github_failed' }),
  (req, res) => res.redirect(req.user.role === 'teacher' ? '/teacher-dashboard.html' : '/dashboard.html')
);

// ---------- Test-platform API routes ----------
app.use('/api/classes', requireAuth, classesRouter);
app.use('/api/tests', requireAuth, testsRouter);
app.use('/api/submissions', requireAuth, submissionsRouter);
app.use('/api/admin', requireAuth, adminRouter);

// ---------- Fallback error handler ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

// Wait for the users table to exist before accepting traffic.
db.schemaReady
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
