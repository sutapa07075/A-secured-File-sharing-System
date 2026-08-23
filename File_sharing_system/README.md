# Vault — Secure Document Share

Backend: Node.js + Express + PostgreSQL (NeonDB) + Backblaze B2
Frontend: vanilla HTML/CSS/JS (no build step)

## What this gives you

- **Envelope encryption**: every file gets a random per-file key (DEK), encrypted with AES-256-GCM
  while streaming (never buffered fully in memory), before it reaches Backblaze. The DEK itself is
  wrapped by a master key (KMS) and only the wrapped version is stored in Postgres. Filenames are
  also field-level encrypted.
- **Leak resistance**: a Postgres leak alone gives an attacker wrapped keys they can't open. A B2
  leak alone gives ciphertext with no keys. Both plus KMS access are needed to read anything.
- **Google OAuth login**, short-lived JWT access tokens + rotated refresh tokens.
- **Row-Level Security** in Postgres as defense-in-depth on top of app-level checks.
- **Sharing**: private / invite-by-email / anyone-with-link, each with view or edit role, expirable.
- **Resilience**: graceful shutdown, `/health` + `/ready`, circuit breakers + retries around B2/KMS calls.
- **Observability**: Prometheus metrics at `/metrics`, structured JSON logs (pino), audit log table.
- **Compliance**: append-only audit trail, retention job with crypto-shred deletion (§ below).

## 1. Prerequisites

- Node.js 18+
- A NeonDB (or any Postgres) database
- A Redis instance (Upstash, Redis Cloud, or local)
- A Backblaze B2 bucket with an Application Key (S3-compatible endpoint)
- A Google Cloud OAuth 2.0 Client ID (Web application type)

## 2. Setup

```bash
cd backend
npm install
cp .env.example .env
# fill in .env: DATABASE_URL, REDIS_URL, GOOGLE_CLIENT_ID/SECRET, B2_*, KMS_MASTER_KEY

# generate the two required secrets:
openssl rand -hex 32   # -> KMS_MASTER_KEY
openssl rand -hex 64   # -> JWT_ACCESS_SECRET
openssl rand -hex 64   # -> JWT_REFRESH_SECRET

npm run migrate    # applies schema.sql (tables + RLS policies) to your database
npm run dev         # starts the API on :4000
```

Serve the frontend as static files (any static server works — the files have no build step):

```bash
cd frontend
npx serve -l 5173 .
# or just open index.html through any static file server; it must match FRONTEND_ORIGIN in .env
```

Visit `http://localhost:5173`, sign in with Google, and you're on the dashboard.

## 3. Google OAuth setup

In Google Cloud Console → APIs & Services → Credentials:
- Create an OAuth Client ID (Web application)
<<<<<<< HEAD
- Authorized redirect URI: `http://localhost:4000/api/auth/google/callback` (update according to your domain)
=======
- Authorized redirect URI: `http://localhost:5173/api/auth/google/callback` (update for production domain)
>>>>>>> 8bd2049840e0b460daaaeb136be9159058cbf414
- Copy the Client ID/Secret into `.env`

## 4. Swapping in real KMS

`src/services/kms.js` currently wraps/unwraps DEKs using a local master key from env — fine for
getting started, but the whole point of KMS is that the master key never lives in your app's
environment. To go to production-grade:

1. Create a Customer Master Key in AWS KMS (or enable Vault's transit secrets engine).
2. Replace `wrapKey`/`unwrapKey` in `kms.js` with calls to `KMSClient.encrypt` / `.decrypt`
   (`@aws-sdk/client-kms`) or Vault's `/transit/encrypt` and `/transit/decrypt` endpoints.
3. Nothing else in the codebase changes — every other module only imports from `kms.js`.

## 5. Data retention & deletion

`src/jobs/retention.js` is meant to run on a schedule (cron, or a BullMQ repeatable job):
1. Crypto-shreds documents past `RETENTION_DAYS` (default 365) by deleting their wrapped DEK —
   this makes the ciphertext in B2 permanently unrecoverable immediately, satisfying "delete" for
   compliance purposes without needing a synchronous B2 call.
2. Physically purges the B2 object + Postgres row 7 days after shredding (grace window in case of
   accidental deletion — the file is already unrecoverable either way, this just reclaims storage).

## 6. Project layout

```
backend/
  src/
    server.js              Express app, security headers, graceful shutdown
    db/
      schema.sql            Tables + Row-Level Security policies
      pool.js                Postgres pool + withUserContext() for RLS session vars
      migrate.js              Applies schema.sql
    services/
      crypto.js               Envelope encryption, streaming encrypt/decrypt, field encryption
      kms.js                    Key-wrapping abstraction (swap for real AWS KMS/Vault)
      storage.js                 Backblaze B2 client (S3-compatible), multipart upload, circuit breaker
      redis.js                    Redis client
    middleware/
      auth.js                JWT verification
      rateLimit.js            Redis-backed rate limiters
    routes/
      auth.js                 Google OAuth, JWT issuance/refresh/logout
      documents.js              Upload/download/share/delete
      health.js                  /health, /ready, /metrics
    jobs/
      retention.js             Scheduled retention + crypto-shred cleanup
    utils/
      audit.js                Append-only audit log writer
      logger.js                 pino logger with secret redaction
frontend/
  index.html         Login screen
  dashboard.html      File list, upload, share modal
  css/style.css        
  js/app.js
```

## 7. Chunked upload (large files)

Files ≥ 20MB automatically use the chunked path (`frontend/js/app.js`, `CHUNK_THRESHOLD_BYTES`).
Flow:

1. `POST /api/documents/upload/init` — creates the doc id, opens a B2 multipart upload, and starts
   an in-memory AES-256-GCM cipher session on the server (`services/uploadSessions.js`).
2. `PUT /api/documents/upload/:docId/chunk` — the browser sends 8MB slices **in order**; each is
   encrypted by the running cipher and forwarded to B2 as one multipart "part". Progress bar tracks
   bytes sent.
3. `POST /api/documents/upload/:docId/complete` — flushes the final GCM block + auth tag, finalizes
   the B2 multipart upload, wraps the DEK, and writes the DB row.
4. `POST /api/documents/upload/:docId/abort` — called automatically if any chunk fails, so B2 doesn't
   accumulate incomplete multipart uploads.

**Important limitation**: the encryption-session state (`uploadSessions.js`) lives in the memory of
whichever Node process handled `/init`. That's fine for a single API instance. But to scale
horizontally behind a load balancer, either (a) enable sticky sessions so a given upload's chunks
always hit the same instance, or (b) move to the zero-knowledge/WebCrypto variant, where the
browser encrypts each chunk independently and the server just relays already-encrypted bytes — that
approach has no server-side cipher state to keep sticky.

Files under 20MB still use the original single-shot `/api/documents/upload` streaming route.

## 8. Undone Parts: 

- **Zero-knowledge option**: the current design encrypts server-side (server can decrypt via KMS,
  but the database/storage alone cannot). If you want the server to *never* see plaintext even
  transiently, move the AES-GCM encrypt/decrypt into the browser via WebCrypto before upload — ask
  and I can build that variant next; it also removes the sticky-session limitation above.

