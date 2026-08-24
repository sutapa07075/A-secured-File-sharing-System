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

-- =========================================================
-- Zero-knowledge mode (additive, separate from the server-side
-- envelope-encryption tables above). In this mode the server never
-- has a usable key: files are encrypted in the browser with WebCrypto
-- before upload, and per-recipient key copies are wrapped client-side
-- too (RSA-OAEP for named users, a fragment-only symmetric key for
-- anonymous share links). See src/routes/zkKeys.js and zkDocuments.js.
-- =========================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS public_key BYTEA;             -- RSA-OAEP public key (JWK, as bytes)
ALTER TABLE users ADD COLUMN IF NOT EXISTS wrapped_private_key BYTEA;    -- private key JWK, encrypted with a passphrase-derived key
ALTER TABLE users ADD COLUMN IF NOT EXISTS private_key_iv BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS private_key_salt BYTEA;       -- PBKDF2 salt used to derive the wrapping key from the user's passphrase
ALTER TABLE users ADD COLUMN IF NOT EXISTS key_created_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS zk_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  filename_ciphertext BYTEA NOT NULL,   -- filename encrypted client-side with the file key (GCM tag included in ciphertext)
  filename_iv BYTEA NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  b2_key TEXT NOT NULL,                 -- raw ciphertext blob; server has no key that can open it
  file_iv BYTEA NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS zk_document_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES zk_documents(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user','link')),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,   -- set when subject_type = 'user' (owner or invited grantee)
  share_code TEXT,                                        -- set when subject_type = 'link'
  wrapped_key BYTEA NOT NULL,          -- file key wrapped for this subject: RSA-OAEP (user) or AES-GCM w/ link key (link)
  role TEXT NOT NULL CHECK (role IN ('view','edit')) DEFAULT 'view',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (document_id, user_id),
  UNIQUE (share_code)
);

CREATE INDEX IF NOT EXISTS idx_zk_keys_document ON zk_document_keys(document_id);
CREATE INDEX IF NOT EXISTS idx_zk_keys_user ON zk_document_keys(user_id);

ALTER TABLE zk_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS zk_doc_owner_access ON zk_documents;
CREATE POLICY zk_doc_owner_access ON zk_documents
  USING (owner_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS zk_doc_shared_access ON zk_documents;
CREATE POLICY zk_doc_shared_access ON zk_documents
  USING (
    id IN (
      SELECT document_id FROM zk_document_keys
      WHERE user_id = current_setting('app.current_user_id', true)::uuid
    )
  );

