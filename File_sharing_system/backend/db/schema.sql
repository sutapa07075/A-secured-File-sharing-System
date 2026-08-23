-- Secure Document Share — Postgres schema
-- Run with: psql "$DATABASE_URL" -f src/db/schema.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,          -- sha256 of the refresh token, never store raw
  revoked BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  filename_encrypted BYTEA NOT NULL,   -- AES-GCM encrypted filename
  filename_iv BYTEA NOT NULL,
  filename_auth_tag BYTEA NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  b2_key TEXT NOT NULL,                -- object key in Backblaze bucket
  wrapped_dek BYTEA NOT NULL,          -- per-file data key, wrapped by KMS master key
  dek_iv BYTEA NOT NULL,               -- iv used to wrap the DEK
  file_iv BYTEA NOT NULL,              -- iv used to encrypt the file content
  file_auth_tag BYTEA NOT NULL,        -- GCM auth tag for the file content
  kms_key_id TEXT NOT NULL,
  chunk_count INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('private','restricted','link')),
  grantee_email TEXT,                  -- set when scope = 'restricted'
  role TEXT NOT NULL CHECK (role IN ('view','edit')) DEFAULT 'view',
  share_code TEXT UNIQUE,              -- set when scope = 'link'
  expires_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permissions_document ON permissions(document_id);
CREATE INDEX IF NOT EXISTS idx_permissions_email ON permissions(grantee_email);
CREATE INDEX IF NOT EXISTS idx_permissions_share_code ON permissions(share_code);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID,
  actor_email TEXT,
  action TEXT NOT NULL,               -- 'view','download','upload','share','revoke','delete','login'
  document_id UUID,
  ip_address INET,
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_document ON audit_log(document_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);

-- =========================================================
-- Row Level Security
-- The app sets app.current_user_id per request (see db/pool.js withUserContext)
-- =========================================================

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS doc_owner_access ON documents;
CREATE POLICY doc_owner_access ON documents
  USING (owner_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS doc_shared_access ON documents;
CREATE POLICY doc_shared_access ON documents
  USING (
    id IN (
      SELECT document_id FROM permissions
      WHERE grantee_email = current_setting('app.current_user_email', true)
         OR scope = 'link'
    )
  );

DROP POLICY IF EXISTS doc_owner_write ON documents;
CREATE POLICY doc_owner_write ON documents
  FOR ALL
  USING (owner_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS permissions_visible ON permissions;
CREATE POLICY permissions_visible ON permissions
  USING (
    document_id IN (
      SELECT id FROM documents WHERE owner_id = current_setting('app.current_user_id', true)::uuid
    )
    OR grantee_email = current_setting('app.current_user_email', true)
  );

-- Data retention: run periodically (see src/jobs/retention.js)
-- Crypto-shred: deleting wrapped_dek makes the B2 ciphertext permanently unrecoverable.
