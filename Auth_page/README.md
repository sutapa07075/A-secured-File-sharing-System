# Auth App — Login / Register with Google, GitHub & SQLite

A self-contained login + register system:

- **Backend:** Node.js, Express, SQLite (`sqlite3`)
- **Frontend:** two plain HTML pages (`login.html`, `register.html`) + vanilla JS, no framework
- **OAuth:** "Continue with Google" and "Continue with GitHub" via Passport
- **Security:** bcrypt password hashing, helmet headers, rate limiting, account lockout after
  repeated failed logins, httpOnly/secure session cookies, generic error messages that don't
  leak which accounts exist
- **Session timeout:** the server session cookie expires after inactivity, and the frontend
  also runs its own inactivity timer that logs the user out and redirects to the login page
- **Password rules:** minimum 6 characters, one uppercase letter, one number, one special
  character — shown live on the register page as a checklist, each rule turns green with a
  check mark once satisfied, and the submit button stays disabled until every rule passes.
  The server re-validates the same rules independently (never trust the client alone).

## 1. Install

```bash
cd server
npm install
cp .env.example .env
```

## 2. Configure `.env`

Open `server/.env` and set:

- `SESSION_SECRET` — any long random string (e.g. `openssl rand -hex 32`)
- `SESSION_TIMEOUT_MINUTES` — how many minutes of inactivity before auto logout (default 15)
- Google and GitHub OAuth credentials (see below). If you leave the placeholder values in
  place, the app still works for email/password login — the OAuth buttons simply won't be
  wired up server-side until you add real keys.

### Google OAuth setup
1. Go to https://console.cloud.google.com/apis/credentials
2. Create an **OAuth client ID** → Application type: **Web application**
3. Authorized redirect URI: `http://localhost:3000/auth/google/callback`
4. Copy the Client ID / Secret into `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`

### GitHub OAuth setup
1. Go to https://github.com/settings/developers → **New OAuth App**
2. Authorization callback URL: `http://localhost:3000/auth/github/callback`
3. Copy the Client ID / Secret into `.env` as `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`

## 3. Run

```bash
npm start
```

Visit `http://localhost:3000/login.html` or `http://localhost:3000/register.html`.

## 4. Going to production

- Set `NODE_ENV=production` — this turns on `secure` cookies, which **requires HTTPS**
  (put the app behind a reverse proxy like nginx or a platform that terminates TLS for you).
- Use a real, private `SESSION_SECRET` and never commit `.env`.
- Consider moving `sessions.db` / `app.db` to a persistent volume if you deploy on
  ephemeral storage (containers, etc.).
- Add HTTPS-only OAuth callback URLs in the Google/GitHub app settings once you have a
  real domain.

## How the pieces fit together

| Concern | Where it lives |
|---|---|
| Password hashing (bcrypt, 12 rounds) | `server/server.js`, `/api/register` |
| Password rule validation (client) | `public/js/register.js` |
| Password rule validation (server) | `server/server.js`, `validatePassword()` |
| Login brute-force protection | `authLimiter` + `failed_login_attempts` / `lock_until` columns |
| Session cookie + rolling timeout | `express-session` config in `server/server.js` |
| Client-side inactivity auto-logout | `public/js/session-guard.js` |
| Google / GitHub login | Passport strategies in `server/server.js`, buttons in both HTML pages |
| Database schema | `server/db.js` |

## Notes on the "direct Gmail" login

There's no way for a website to log a user in with their Gmail password directly — that's
by design, for the user's own security. What "Continue with Google" does instead is the
standard, secure approach: Google itself checks the user's password on Google's own login
page, then hands this app a token confirming who they are. That's the same mechanism GitHub,
Facebook, and virtually every "Sign in with X" button uses.
