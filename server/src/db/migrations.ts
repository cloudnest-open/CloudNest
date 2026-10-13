import type Database from 'better-sqlite3';

/**
 * Ordered, immutable migrations (Step 2 metadata schema).
 * Each migration runs inside one transaction via the Step 1 runner.
 * Never edit a released migration; add a new one for schema changes.
 */

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

const M0001_INFRASTRUCTURE: Migration = {
  version: 1,
  name: '0001-migration-infrastructure-check',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },
};

const M0002_CORE_METADATA_SCHEMA: Migration = {
  version: 2,
  name: '0002-core-metadata-schema',
  up: (db) => {
    // Singleton admin account (one row, fixed username).
    db.exec(`
      CREATE TABLE admin_users (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        username TEXT NOT NULL UNIQUE CHECK(username = 'admin'),
        password_hash TEXT NOT NULL,
        password_changed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        auth_version INTEGER NOT NULL DEFAULT 1 CHECK(auth_version >= 1)
      );
    `);

    // Server-side sessions (express-session store). Expiry in Unix ms.
    db.exec(`
      CREATE TABLE sessions (
        sid_hash TEXT PRIMARY KEY,
        session_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
    `);

    // Allowlisted non-secret settings only.
    db.exec(`
      CREATE TABLE app_settings (
        setting_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Provider accounts (structural groundwork; features arrive in Step 3+).
    db.exec(`
      CREATE TABLE provider_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider IN ('google_drive','dropbox','pcloud','mega','onedrive')),
        display_label TEXT NOT NULL,
        account_identifier TEXT,
        status TEXT NOT NULL CHECK(status IN ('connected','disconnected','error','reauth_required')),
        quota_total_bytes INTEGER CHECK(quota_total_bytes IS NULL OR quota_total_bytes >= 0),
        used_bytes INTEGER CHECK(used_bytes IS NULL OR used_bytes >= 0),
        reserve_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserve_bytes >= 0),
        reserved_inflight_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_inflight_bytes >= 0),
        last_quota_check_at TEXT,
        credential_ciphertext BLOB,
        credential_nonce BLOB,
        credential_auth_tag BLOB,
        credential_key_version INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_provider_accounts_provider_status ON provider_accounts(provider, status);
    `);

    // Logical files and their chunks (metadata only, never bytes).
    db.exec(`
      CREATE TABLE files (
        id TEXT PRIMARY KEY,
        original_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        mime_type TEXT,
        chunk_size_bytes INTEGER NOT NULL CHECK(chunk_size_bytes > 0),
        chunk_count INTEGER NOT NULL CHECK(chunk_count >= 0),
        whole_sha256 TEXT,
        manifest_hash TEXT,
        state TEXT NOT NULL CHECK(state IN ('draft','uploading','completed','deleting','failed')),
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX idx_files_state_created ON files(state, created_at);

      CREATE TABLE file_chunks (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
        chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
        offset_bytes INTEGER NOT NULL CHECK(offset_bytes >= 0),
        size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
        sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','uploaded','failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(file_id, chunk_index)
      );
      CREATE INDEX idx_file_chunks_file ON file_chunks(file_id, chunk_index);

      CREATE TABLE chunk_placements (
        id TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL REFERENCES file_chunks(id) ON DELETE RESTRICT,
        provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
        remote_object_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending','active','unavailable','deleting','deleted','failed')),
        is_active INTEGER NOT NULL CHECK(is_active IN (0,1)),
        last_safe_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_chunk_placements_chunk_state ON chunk_placements(chunk_id, state);
      CREATE UNIQUE INDEX idx_chunk_placements_active ON chunk_placements(chunk_id) WHERE is_active = 1;
    `);

    // Transfer jobs (structural; engine arrives later).
    db.exec(`
      CREATE TABLE transfer_jobs (
        id TEXT PRIMARY KEY,
        file_id TEXT REFERENCES files(id) ON DELETE RESTRICT,
        job_type TEXT NOT NULL CHECK(job_type IN ('upload','download','delete','repair','reconcile')),
        state TEXT NOT NULL CHECK(state IN ('queued','running','paused','failed','completed','cancelled','deletion_pending')),
        chunks_completed INTEGER NOT NULL DEFAULT 0 CHECK(chunks_completed >= 0),
        chunks_total INTEGER NOT NULL DEFAULT 0 CHECK(chunks_total >= 0),
        bytes_completed INTEGER NOT NULL DEFAULT 0 CHECK(bytes_completed >= 0),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
        last_safe_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(file_id IS NOT NULL OR job_type = 'reconcile')
      );
      CREATE INDEX idx_transfer_jobs_state ON transfer_jobs(state, updated_at);
    `);

    // Share links (structural).
    db.exec(`
      CREATE TABLE share_links (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        expires_at TEXT,
        download_limit INTEGER CHECK(download_limit IS NULL OR download_limit > 0),
        download_count INTEGER NOT NULL DEFAULT 0 CHECK(download_count >= 0),
        state TEXT NOT NULL CHECK(state IN ('active','revoked','expired')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_share_links_token_state ON share_links(token_hash, state);

      CREATE TABLE share_link_items (
        share_link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
        PRIMARY KEY (share_link_id, file_id)
      );
      CREATE INDEX idx_share_link_items_link ON share_link_items(share_link_id);
    `);

    // Security/audit events. No secrets, no raw tokens, no passwords.
    db.exec(`
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        success INTEGER NOT NULL CHECK(success IN (0,1)),
        reason_code TEXT NOT NULL,
        metadata_json TEXT
      );
    `);
  },
};

const M0003_PROVIDER_CONNECTIONS: Migration = {
  version: 3,
  name: '0003-provider-connections',
  up: (db) => {
    // One-time provider app credentials (encrypted). MEGA has no OAuth app config.
    db.exec(`
      CREATE TABLE provider_app_configs (
        provider TEXT PRIMARY KEY CHECK(provider IN ('google_drive','dropbox','pcloud','onedrive')),
        config_ciphertext BLOB NOT NULL,
        config_nonce BLOB NOT NULL,
        config_auth_tag BLOB NOT NULL,
        config_key_version INTEGER NOT NULL CHECK(config_key_version > 0),
        verification_status TEXT NOT NULL CHECK(verification_status IN ('saved','verified','needs_correction')) DEFAULT 'saved',
        last_verified_at TEXT,
        last_safe_error_code TEXT,
        last_error_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Step 2 kept status CHECK at ('connected','disconnected','error','reauth_required');
    // the canonical account states are connected/needs_reauth/disconnected/error.
    // Rebuild provider_accounts with the canonical CHECK + new quota/error columns.
    db.exec(`
      CREATE TABLE provider_accounts_new (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider IN ('google_drive','dropbox','pcloud','mega','onedrive')),
        display_label TEXT NOT NULL,
        account_identifier TEXT,
        status TEXT NOT NULL CHECK(status IN ('connected','needs_reauth','disconnected','error')),
        quota_total_bytes INTEGER CHECK(quota_total_bytes IS NULL OR quota_total_bytes >= 0),
        used_bytes INTEGER CHECK(used_bytes IS NULL OR used_bytes >= 0),
        quota_status TEXT NOT NULL DEFAULT 'unknown' CHECK(quota_status IN ('current','stale','unknown')),
        reserve_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserve_bytes >= 0),
        reserved_inflight_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_inflight_bytes >= 0),
        last_quota_check_at TEXT,
        last_quota_error_code TEXT,
        last_quota_error_at TEXT,
        last_error_code TEXT,
        last_error_at TEXT,
        credential_ciphertext BLOB,
        credential_nonce BLOB,
        credential_auth_tag BLOB,
        credential_key_version INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // map old status values; preserve all rows and columns
    db.exec(`
      INSERT INTO provider_accounts_new
        (id, provider, display_label, account_identifier, status, quota_total_bytes, used_bytes,
         reserve_bytes, reserved_inflight_bytes, last_quota_check_at,
         credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version,
         created_at, updated_at)
      SELECT id, provider, display_label, account_identifier,
        CASE status
          WHEN 'connected' THEN 'connected'
          WHEN 'reauth_required' THEN 'needs_reauth'
          WHEN 'disconnected' THEN 'disconnected'
          WHEN 'error' THEN 'error'
        END,
        quota_total_bytes, used_bytes, reserve_bytes, reserved_inflight_bytes, last_quota_check_at,
        credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version,
        created_at, updated_at
      FROM provider_accounts;
    `);
    db.exec('DROP TABLE provider_accounts;');
    db.exec('ALTER TABLE provider_accounts_new RENAME TO provider_accounts;');
    db.exec('CREATE INDEX idx_provider_accounts_provider_status ON provider_accounts(provider, status);');
    db.exec('CREATE UNIQUE INDEX idx_provider_accounts_identity ON provider_accounts(provider, account_identifier) WHERE account_identifier IS NOT NULL;');
    // verify referential integrity after the rebuild
    const violations = db.pragma('foreign_key_check', { simple: true });
    if (violations) {
      throw new Error('foreign_key_check failed after provider_accounts rebuild');
    }
  },
};

const M0004_PROVIDER_ACCOUNT_ROOTS: Migration = {
  version: 4,
  name: '0004-provider-account-roots',
  up: (db) => {
    // One dedicated CloudNest-managed root per provider account (created lazily
    // on first upload by an idempotent ensure/find flow).
    db.exec(`
      CREATE TABLE provider_account_roots (
        provider_account_id TEXT PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE RESTRICT,
        remote_root_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ready','missing','needs_reauth','error')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Upload-capability tracking so a connector that cannot stream safely is
    // visibly unsupported instead of silently using a different path.
    db.exec(`
      CREATE TABLE provider_capabilities (
        provider_account_id TEXT PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE RESTRICT,
        upload_supported INTEGER NOT NULL CHECK(upload_supported IN (0,1)),
        download_supported INTEGER NOT NULL CHECK(download_supported IN (0,1)),
        list_supported INTEGER NOT NULL CHECK(list_supported IN (0,1)),
        reason_code TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  },
};

const M0005_CHUNK_PLACEMENT_OBJECT_KEY: Migration = {
  version: 5,
  name: '0005-chunk-placement-object-key',
  up: (db) => {
    // Recover a provider object by its known app-generated key after a crash
    // before its remote object ID was committed.
    db.exec('ALTER TABLE chunk_placements ADD COLUMN remote_object_key TEXT;');
    db.exec('CREATE INDEX idx_chunk_placements_object_key ON chunk_placements(remote_object_key);');
    // Integrity/verification state for a committed placement.
    db.exec("ALTER TABLE chunk_placements ADD COLUMN provider_checksum_type TEXT;");
    db.exec('ALTER TABLE chunk_placements ADD COLUMN confirmed_size_bytes INTEGER;');
  },
};

export const allMigrations: readonly Migration[] = [
  M0001_INFRASTRUCTURE,
  M0002_CORE_METADATA_SCHEMA,
  M0003_PROVIDER_CONNECTIONS,
  M0004_PROVIDER_ACCOUNT_ROOTS,
  M0005_CHUNK_PLACEMENT_OBJECT_KEY,
];
