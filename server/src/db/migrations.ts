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
  /**
   * Set ONLY when SQLite physically cannot perform the change inside a
   * transaction — rebuilding a parent table whose children reference it with
   * ON DELETE RESTRICT is the canonical case: RESTRICT is enforced
   * immediately even under defer_foreign_keys, and PRAGMA foreign_keys is a
   * no-op inside a transaction. A migration with this flag runs WITHOUT the
   * transactional wrapper and MUST manage its own safety: disable foreign
   * keys first, rebuild, then verify `foreign_key_check` before re-enabling
   * (the documented procedure in sqlite.org/lang_altertable.html §7). Every
   * other migration stays fully transactional.
   */
  requiresForeignKeysOff?: boolean;
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

const M0006_UPLOAD_ENGINE: Migration = {
  version: 6,
  name: '0006-upload-engine',
  up: (db) => {
    // Persisted plan idempotency: a lost HTTP response must not create a
    // second file/job or reserve capacity twice.
    db.exec('ALTER TABLE transfer_jobs ADD COLUMN idempotency_key TEXT;');
    db.exec('ALTER TABLE transfer_jobs ADD COLUMN request_fingerprint TEXT;');
    db.exec('CREATE UNIQUE INDEX idx_transfer_jobs_idempotency ON transfer_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;');

    // One reservation row per (job, chunk) — durable BEFORE any bytes are sent.
    db.exec(`
      CREATE TABLE upload_chunk_allocations (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES transfer_jobs(id) ON DELETE RESTRICT,
        chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
        provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
        size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
        offset_bytes INTEGER NOT NULL CHECK(offset_bytes >= 0),
        state TEXT NOT NULL CHECK(state IN ('reserved','uploading','uploaded_pending_quota','released','needs_replan')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(job_id, chunk_index)
      );
      CREATE INDEX idx_allocations_job_state ON upload_chunk_allocations(job_id, state);
      CREATE INDEX idx_allocations_account_state ON upload_chunk_allocations(provider_account_id, state);
    `);

    // One durable row per upload attempt, recorded even before file_chunks can
    // be safely committed. Holds opaque provider resume state (write-only).
    db.exec(`
      CREATE TABLE upload_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES transfer_jobs(id) ON DELETE RESTRICT,
        chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
        provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
        object_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('uploading','uploaded_uncommitted','committed','cleanup_pending','cleaned','failed')),
        bytes_received INTEGER NOT NULL DEFAULT 0 CHECK(bytes_received >= 0),
        sha256 TEXT,
        remote_object_id TEXT,
        safe_error_code TEXT,
        provider_resume_state_ciphertext BLOB,
        provider_resume_state_nonce BLOB,
        provider_resume_state_auth_tag BLOB,
        provider_resume_state_key_version INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(object_key)
      );
      CREATE INDEX idx_attempts_job_state ON upload_attempts(job_id, state);
      CREATE INDEX idx_attempts_object_key ON upload_attempts(object_key);
    `);
  },
};

const M0007_PLACEMENT_STATES: Migration = {
  version: 7,
  name: '0007-placement-upload-states',
  up: (db) => {
    // Migration 5 constrained placement states to the Step-2 placeholder list.
    // The upload engine needs the canonical set from the Step 4 plan, including
    // 'verified' (a trusted provider checksum or read-back confirmed the bytes).
    // Rebuild the table to widen the CHECK while preserving every row, index and
    // child reference; never edit an applied migration.
    db.exec(`
      CREATE TABLE chunk_placements_new (
        id TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL REFERENCES file_chunks(id) ON DELETE RESTRICT,
        provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
        remote_object_id TEXT,
        remote_object_key TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending','uploading','uploaded','verified','failed','missing','deletion_pending','unavailable','deleting','deleted')),
        is_active INTEGER NOT NULL CHECK(is_active IN (0,1)),
        provider_checksum_type TEXT,
        confirmed_size_bytes INTEGER CHECK(confirmed_size_bytes IS NULL OR confirmed_size_bytes >= 0),
        last_safe_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      INSERT INTO chunk_placements_new
        (id, chunk_id, provider_account_id, remote_object_id, remote_object_key, state, is_active,
         provider_checksum_type, confirmed_size_bytes, last_safe_error_code, created_at, updated_at)
      SELECT id, chunk_id, provider_account_id, remote_object_id, remote_object_key, state, is_active,
         provider_checksum_type, confirmed_size_bytes, last_safe_error_code, created_at, updated_at
      FROM chunk_placements;
    `);
    db.exec('DROP TABLE chunk_placements;');
    db.exec('ALTER TABLE chunk_placements_new RENAME TO chunk_placements;');
    db.exec('CREATE INDEX idx_chunk_placements_chunk_state ON chunk_placements(chunk_id, state);');
    db.exec('CREATE UNIQUE INDEX idx_chunk_placements_active ON chunk_placements(chunk_id) WHERE is_active = 1;');
    db.exec('CREATE INDEX idx_chunk_placements_object_key ON chunk_placements(remote_object_key);');
    const violations = db.pragma('foreign_key_check');
    if (Array.isArray(violations) ? violations.length > 0 : Boolean(violations)) {
      throw new Error('foreign_key_check failed after chunk_placements rebuild');
    }
  },
};

const M0008_DOWNLOAD_ENGINE: Migration = {
  version: 8,
  name: '0008-download-engine',
  up: (db) => {
    // A file whose chunks are missing or hash-mismatched needs an honest state
    // rather than looking "completed". Rebuild the table to widen the CHECK,
    // preserving every row and the foreign keys that reference it.
    db.exec(`
      CREATE TABLE files_new (
        id TEXT PRIMARY KEY,
        original_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        mime_type TEXT,
        chunk_size_bytes INTEGER NOT NULL CHECK(chunk_size_bytes > 0),
        chunk_count INTEGER NOT NULL CHECK(chunk_count >= 0),
        whole_sha256 TEXT,
        manifest_hash TEXT,
        state TEXT NOT NULL CHECK(state IN ('draft','uploading','completed','incomplete','needs_repair','deleting','deletion_pending','deleted','failed')),
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
    db.exec(`
      INSERT INTO files_new (id, original_name, size_bytes, mime_type, chunk_size_bytes, chunk_count,
        whole_sha256, manifest_hash, state, created_at, completed_at)
      SELECT id, original_name, size_bytes, mime_type, chunk_size_bytes, chunk_count,
        whole_sha256, manifest_hash, state, created_at, completed_at FROM files;
    `);
    db.exec('DROP TABLE files;');
    db.exec('ALTER TABLE files_new RENAME TO files;');
    db.exec('CREATE INDEX idx_files_state_created ON files(state, created_at);');
    // re-create the child foreign keys that pointed at files
    db.exec(`
      CREATE TABLE file_chunks_new (
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
    `);
    db.exec(`INSERT INTO file_chunks_new SELECT id, file_id, chunk_index, offset_bytes, size_bytes, sha256, state, created_at, updated_at FROM file_chunks;`);
    db.exec('DROP TABLE file_chunks;');
    db.exec('ALTER TABLE file_chunks_new RENAME TO file_chunks;');
    db.exec('CREATE INDEX idx_file_chunks_file ON file_chunks(file_id, chunk_index);');

    db.exec(`
      CREATE TABLE chunk_placements_new (
        id TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL REFERENCES file_chunks(id) ON DELETE RESTRICT,
        provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
        remote_object_id TEXT,
        remote_object_key TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending','uploading','uploaded','verified','failed','missing','deletion_pending','unavailable','deleting','deleted')),
        is_active INTEGER NOT NULL CHECK(is_active IN (0,1)),
        provider_checksum_type TEXT,
        confirmed_size_bytes INTEGER CHECK(confirmed_size_bytes IS NULL OR confirmed_size_bytes >= 0),
        last_safe_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`INSERT INTO chunk_placements_new SELECT id, chunk_id, provider_account_id, remote_object_id, remote_object_key, state, is_active, provider_checksum_type, confirmed_size_bytes, last_safe_error_code, created_at, updated_at FROM chunk_placements;`);
    db.exec('DROP TABLE chunk_placements;');
    db.exec('ALTER TABLE chunk_placements_new RENAME TO chunk_placements;');
    db.exec('CREATE INDEX idx_chunk_placements_chunk_state ON chunk_placements(chunk_id, state);');
    db.exec('CREATE UNIQUE INDEX idx_chunk_placements_active ON chunk_placements(chunk_id) WHERE is_active = 1;');
    db.exec('CREATE INDEX idx_chunk_placements_object_key ON chunk_placements(remote_object_key);');

    db.exec(`
      CREATE TABLE transfer_jobs_new (
        id TEXT PRIMARY KEY,
        file_id TEXT REFERENCES files(id) ON DELETE RESTRICT,
        job_type TEXT NOT NULL CHECK(job_type IN ('upload','download','delete','repair','reconcile')),
        state TEXT NOT NULL CHECK(state IN ('queued','running','paused','failed','completed','cancelled','deletion_pending')),
        chunks_completed INTEGER NOT NULL DEFAULT 0 CHECK(chunks_completed >= 0),
        chunks_total INTEGER NOT NULL DEFAULT 0 CHECK(chunks_total >= 0),
        bytes_completed INTEGER NOT NULL DEFAULT 0 CHECK(bytes_completed >= 0),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
        last_safe_error_code TEXT,
        idempotency_key TEXT,
        request_fingerprint TEXT,
        requested_range_start_bytes INTEGER CHECK(requested_range_start_bytes IS NULL OR requested_range_start_bytes >= 0),
        requested_range_end_bytes INTEGER CHECK(requested_range_end_bytes IS NULL OR requested_range_end_bytes >= 0),
        requested_bytes INTEGER CHECK(requested_bytes IS NULL OR requested_bytes >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(file_id IS NOT NULL OR job_type = 'reconcile')
      );
    `);
    db.exec(`INSERT INTO transfer_jobs_new (id, file_id, job_type, state, chunks_completed, chunks_total, bytes_completed, retry_count, last_safe_error_code, idempotency_key, request_fingerprint, created_at, updated_at)
      SELECT id, file_id, job_type, state, chunks_completed, chunks_total, bytes_completed, retry_count, last_safe_error_code, idempotency_key, request_fingerprint, created_at, updated_at FROM transfer_jobs;`);
    db.exec('DROP TABLE transfer_jobs;');
    db.exec('ALTER TABLE transfer_jobs_new RENAME TO transfer_jobs;');
    db.exec('CREATE INDEX idx_transfer_jobs_state ON transfer_jobs(state, updated_at);');
    db.exec('CREATE UNIQUE INDEX idx_transfer_jobs_idempotency ON transfer_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;');

    db.exec(`
      CREATE TABLE share_link_items_new (
        share_link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
        PRIMARY KEY (share_link_id, file_id)
      );
    `);
    db.exec('INSERT INTO share_link_items_new SELECT share_link_id, file_id FROM share_link_items;');
    db.exec('DROP TABLE share_link_items;');
    db.exec('ALTER TABLE share_link_items_new RENAME TO share_link_items;');
    db.exec('CREATE INDEX idx_share_link_items_link ON share_link_items(share_link_id);');

    const violations = db.pragma('foreign_key_check');
    if (Array.isArray(violations) ? violations.length > 0 : Boolean(violations)) {
      throw new Error('foreign_key_check failed after the download-engine rebuild');
    }
  },
};

const M0009_SHARE_LINKS: Migration = {
  version: 9,
  name: '0009-share-links',
  up: (db) => {
    // Step 2 created share_links with a placeholder state set; the approved
    // share design needs the canonical vocabulary plus revocation bookkeeping.
    db.exec(`
      CREATE TABLE share_links_new (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        expires_at TEXT,
        download_limit INTEGER CHECK(download_limit IS NULL OR download_limit > 0),
        download_count INTEGER NOT NULL DEFAULT 0 CHECK(download_count >= 0),
        state TEXT NOT NULL CHECK(state IN ('active','revoked','expired','deleted')),
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      INSERT INTO share_links_new (id, token_hash, password_hash, expires_at, download_limit, download_count, state, created_at, updated_at)
      SELECT id, token_hash, password_hash, expires_at, download_limit, download_count, state, created_at, updated_at FROM share_links;
    `);
    db.exec('DROP TABLE share_links;');
    db.exec('ALTER TABLE share_links_new RENAME TO share_links;');
    db.exec('CREATE INDEX idx_share_links_token_state ON share_links(token_hash, state);');
    db.exec('CREATE INDEX idx_share_links_state ON share_links(state, expires_at);');

    // re-create the child table that referenced share_links
    db.exec(`
      CREATE TABLE share_link_items_new (
        share_link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
        PRIMARY KEY (share_link_id, file_id)
      );
    `);
    db.exec('INSERT INTO share_link_items_new SELECT share_link_id, file_id FROM share_link_items;');
    db.exec('DROP TABLE share_link_items;');
    db.exec('ALTER TABLE share_link_items_new RENAME TO share_link_items;');
    db.exec('CREATE INDEX idx_share_link_items_link ON share_link_items(share_link_id);');

    // One download-start consume record per authorized public download.
    // Only a hash of the temporary token is stored; never the raw token.
    db.exec(`
      CREATE TABLE share_download_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        share_link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK(state IN ('active','consumed','expired','revoked')),
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_share_sessions_expiry ON share_download_sessions(expires_at);
      CREATE INDEX idx_share_sessions_link ON share_download_sessions(share_link_id, state);
      CREATE INDEX idx_share_sessions_file ON share_download_sessions(file_id);
    `);

    // Deletion bookkeeping: a durable record of what still needs remote cleanup.
    db.exec(`
      CREATE TABLE deletion_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES transfer_jobs(id) ON DELETE RESTRICT,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
        chunk_id TEXT NOT NULL,
        provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
        remote_object_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending','deleted','not_found','failed','cleanup_pending')),
        last_safe_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_deletion_attempts_job ON deletion_attempts(job_id, state);
    `);

    const violations = db.pragma('foreign_key_check');
    if (Array.isArray(violations) ? violations.length > 0 : Boolean(violations)) {
      throw new Error('foreign_key_check failed after the share-links rebuild');
    }
  },
};

const M0010_SHARE_UNLOCK_GRANTS: Migration = {
  version: 10,
  name: '0010-share-unlock-grants',
  up: (db) => {
    // SH-1 remediation: a password-protected link must gate its downloads on
    // a successful unlock, not on knowing the public token plus a file id.
    // A grant is a share-bound, expiring proof-of-unlock. Only its SHA-256
    // hash is stored, exactly like link and session tokens.
    db.exec(`
      CREATE TABLE share_unlock_grants (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        share_link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('active','expired','revoked')),
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_share_unlock_grants_hash ON share_unlock_grants(token_hash, state);
      CREATE INDEX idx_share_unlock_grants_link ON share_unlock_grants(share_link_id, state);
      CREATE INDEX idx_share_unlock_grants_expiry ON share_unlock_grants(expires_at);
    `);
  },
};

const M0011_QUOTA_SCOPE_AND_RECONCILE: Migration = {
  version: 11,
  name: '0011-quota-scope-and-reconcile',
  up: (db) => {
    // Multi-account storage-pool reliability task (§6.1, §6.2):
    // - used_bytes_at_commit: the account's observed used_bytes when a chunk
    //   was committed. A fresh quota observation may release the matching
    //   uploaded_pending_quota reservation only when observed usage has grown
    //   by at least those bytes since commit (propagation proof); NULL keeps
    //   the reservation forever (conservative, e.g. quota was unknown).
    // - quota_scope: NULL = independent quota. A non-null key groups accounts
    //   the owner confirmed share one provider pool, so capacity is counted
    //   and reserved once per pool, never once per login.
    // - quota_unlimited: provider-documented unlimited quota (e.g. Google
    //   Drive about.storageQuota omits limit when storage is unlimited). It is
    //   never an invented numeric total; it may satisfy a plan up to the
    //   requested bytes only.
    db.exec(`ALTER TABLE upload_chunk_allocations ADD COLUMN used_bytes_at_commit INTEGER;`);
    db.exec(`ALTER TABLE provider_accounts ADD COLUMN quota_scope TEXT;`);
    db.exec(
      `ALTER TABLE provider_accounts ADD COLUMN quota_unlimited INTEGER NOT NULL DEFAULT 0 CHECK(quota_unlimited IN (0,1));`,
    );
    db.exec(`CREATE INDEX idx_provider_accounts_quota_scope ON provider_accounts(quota_scope) WHERE quota_scope IS NOT NULL;`);
    // verify referential integrity after the alteration
    const violations = db.pragma('foreign_key_check', { simple: true });
    if (violations) {
      throw new Error('foreign_key_check failed after quota scope migration');
    }
  },
};

const M0012_S3_BUSINESS_TIER: Migration = {
  version: 12,
  name: '0012-s3-business-tier',
  // The provider CHECK must widen to accept 's3', which SQLite cannot do in
  // place: provider_accounts must be rebuilt. Eight child tables reference it
  // with ON DELETE RESTRICT, whose enforcement is immediate even under
  // defer_foreign_keys, so this rebuild can only run with foreign keys
  // disabled — the documented altertable procedure, outside a transaction.
  requiresForeignKeysOff: true,
  up: (db) => {
    // Roadmap Phase 1 (two tiers, one engine):
    // - provider_accounts.tier: personal (the five OAuth connectors) vs
    //   business (S3-compatible). Routing policy sends a file only to its own
    //   tier's pool, so business files never land on personal accounts.
    // - provider_accounts.capacity_cap_bytes: the owner-set per-bucket cap
    //   for S3-compatible accounts. S3 exposes no quota API, so this cap plus
    //   CloudNest-tracked byte sums is the only honest quota; NULL for
    //   provider-reported-quota accounts.
    // - files.tier records the tier a file was planned for, keeping the
    //   routing constraint checkable and auditable after the fact.
    // retry safety: a previous interrupted run can only have left the staging
    // table behind; every other statement is part of the checked sequence
    db.exec('DROP TABLE IF EXISTS provider_accounts_new;');
    db.exec(`
      CREATE TABLE provider_accounts_new (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider IN ('google_drive','dropbox','pcloud','mega','onedrive','s3')),
        display_label TEXT NOT NULL,
        account_identifier TEXT,
        status TEXT NOT NULL CHECK(status IN ('connected','needs_reauth','disconnected','error')),
        tier TEXT NOT NULL DEFAULT 'personal' CHECK(tier IN ('personal','business')),
        quota_total_bytes INTEGER CHECK(quota_total_bytes IS NULL OR quota_total_bytes >= 0),
        used_bytes INTEGER CHECK(used_bytes IS NULL OR used_bytes >= 0),
        quota_status TEXT NOT NULL DEFAULT 'unknown' CHECK(quota_status IN ('current','stale','unknown')),
        quota_unlimited INTEGER NOT NULL DEFAULT 0 CHECK(quota_unlimited IN (0,1)),
        quota_scope TEXT,
        capacity_cap_bytes INTEGER CHECK(capacity_cap_bytes IS NULL OR capacity_cap_bytes > 0),
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
    // every existing account is personal by definition (only OAuth existed so far)
    db.exec(`
      INSERT INTO provider_accounts_new
        (id, provider, display_label, account_identifier, status, tier,
         quota_total_bytes, used_bytes, quota_status, quota_unlimited, quota_scope, capacity_cap_bytes,
         reserve_bytes, reserved_inflight_bytes, last_quota_check_at,
         last_quota_error_code, last_quota_error_at, last_error_code, last_error_at,
         credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version,
         created_at, updated_at)
      SELECT id, provider, display_label, account_identifier, status, 'personal',
         quota_total_bytes, used_bytes, quota_status, quota_unlimited, quota_scope, NULL,
         reserve_bytes, reserved_inflight_bytes, last_quota_check_at,
         last_quota_error_code, last_quota_error_at, last_error_code, last_error_at,
         credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version,
         created_at, updated_at
      FROM provider_accounts;
    `);
    db.exec('DROP TABLE provider_accounts;');
    db.exec('ALTER TABLE provider_accounts_new RENAME TO provider_accounts;');
    db.exec('CREATE INDEX idx_provider_accounts_provider_status ON provider_accounts(provider, status);');
    db.exec('CREATE UNIQUE INDEX idx_provider_accounts_identity ON provider_accounts(provider, account_identifier) WHERE account_identifier IS NOT NULL;');
    db.exec('CREATE INDEX idx_provider_accounts_quota_scope ON provider_accounts(quota_scope) WHERE quota_scope IS NOT NULL;');
    db.exec('CREATE INDEX idx_provider_accounts_tier ON provider_accounts(tier);');
    db.exec(
      `ALTER TABLE files ADD COLUMN tier TEXT NOT NULL DEFAULT 'personal' CHECK(tier IN ('personal','business'));`,
    );
    const violations = db.pragma('foreign_key_check', { simple: true });
    if (violations) {
      throw new Error('foreign_key_check failed after the S3 business-tier migration');
    }
  },
};

const M0013_MULTI_USER: Migration = {
  version: 13,
  name: '0013-multi-user-foundation',
  // Roadmap Phase 3 (multi-user foundation):
  // - users: every principal that can own files. The built-in root admin is
  //   seeded here as the ATTRIBUTION identity for all pre-multi-user data; its
  //   credentials stay in admin_users (the root admin keeps signing in with the
  //   username 'admin', never an email, through the existing login path).
  // - user_tokens: single-use invite / password-reset tokens. Only the SHA-256
  //   hash is stored, exactly like share-link and session tokens.
  // - files.user_id: NOT NULL with a foreign key to users, which SQLite cannot
  //   add in place. file_chunks/share_link_items/transfer_jobs/deletion_attempts
  //   reference files with ON DELETE RESTRICT, so the rebuild follows the
  //   documented altertable §7 procedure with foreign keys disabled — the same
  //   exception M0012 uses — and verifies foreign_key_check before re-enabling.
  // - share_links.created_by: who created a link, so members only manage their
  //   own. Nullable ADD COLUMN with a REFERENCES clause is legal in SQLite
  //   (NULL default), so this one stays a plain ALTER.
  requiresForeignKeysOff: true,
  up: (db) => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','member')),
        status TEXT NOT NULL CHECK(status IN ('active','invited','disabled')),
        password_hash TEXT,
        password_changed_at TEXT,
        allowance_bytes INTEGER CHECK(allowance_bytes IS NULL OR allowance_bytes >= 0),
        auth_version INTEGER NOT NULL DEFAULT 1 CHECK(auth_version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // db.exec cannot bind parameters: the seeded row is written through a
    // prepared statement like every other parameterized write.
    db.prepare(
      `INSERT INTO users (id, email, display_name, role, status, password_hash, password_changed_at,
        allowance_bytes, auth_version, created_at, updated_at)
       VALUES ('usr_admin', 'admin', 'admin', 'admin', 'active', NULL, NULL, NULL, 1, ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());

    db.exec(`
      CREATE TABLE user_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK(purpose IN ('invite','password_reset')),
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_user_tokens_user ON user_tokens(user_id, purpose);
      CREATE INDEX idx_user_tokens_expiry ON user_tokens(expires_at);
    `);

    // rebuild files with the owner column; every existing row belongs to the
    // built-in admin by definition (only one principal existed until now)
    db.exec('DROP TABLE IF EXISTS files_new;');
    db.exec(`
      CREATE TABLE files_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        original_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        mime_type TEXT,
        chunk_size_bytes INTEGER NOT NULL CHECK(chunk_size_bytes > 0),
        chunk_count INTEGER NOT NULL CHECK(chunk_count >= 0),
        whole_sha256 TEXT,
        manifest_hash TEXT,
        state TEXT NOT NULL CHECK(state IN ('draft','uploading','completed','incomplete','needs_repair','deleting','deletion_pending','deleted','failed')),
        tier TEXT NOT NULL DEFAULT 'personal' CHECK(tier IN ('personal','business')),
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
    db.exec(`
      INSERT INTO files_new (id, user_id, original_name, size_bytes, mime_type, chunk_size_bytes, chunk_count,
        whole_sha256, manifest_hash, state, tier, created_at, completed_at)
      SELECT id, 'usr_admin', original_name, size_bytes, mime_type, chunk_size_bytes, chunk_count,
        whole_sha256, manifest_hash, state, tier, created_at, completed_at
      FROM files;
    `);
    db.exec('DROP TABLE files;');
    db.exec('ALTER TABLE files_new RENAME TO files;');
    db.exec('CREATE INDEX idx_files_state_created ON files(state, created_at);');
    db.exec('CREATE INDEX idx_files_user_created ON files(user_id, created_at);');

    db.exec('ALTER TABLE share_links ADD COLUMN created_by TEXT REFERENCES users(id);');
    db.exec("UPDATE share_links SET created_by = 'usr_admin' WHERE created_by IS NULL;");
    db.exec('CREATE INDEX idx_share_links_created_by ON share_links(created_by) WHERE created_by IS NOT NULL;');

    const violations = db.pragma('foreign_key_check', { simple: true });
    if (violations) {
      throw new Error('foreign_key_check failed after the multi-user migration');
    }
  },
};

const M0014_FOLDERS_TRASH_NOTIFICATIONS: Migration = {
  version: 14,
  name: '0014-folders-trash-notifications',
  // Roadmap Phase 4 (Full-feel UX):
  // - folders: the folder tree. Every principal owns a separate tree; files
  //   attach to folders through files.parent_id (NULL = that owner's root).
  //   parent_id is self-referencing on folders and nullable on files, so both
  //   are plain ADD COLUMN / CREATE TABLE statements — no table rebuild, no
  //   foreign_keysOff exception, and foreign_key_check still runs after.
  // - files.trashed_at: the restore window. A trashed file keeps its state,
  //   chunks and placements untouched; only the real purge (which goes through
  //   the durable deletion engine) removes anything remote. NULL = not trashed.
  // - notifications: the per-principal feed behind the bell (upload finished,
  //   share used, quota warning). payload is a JSON string; kind is closed.
  up: (db) => {
    db.exec(`
      CREATE TABLE folders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        parent_id TEXT REFERENCES folders(id),
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_folders_unique_name ON folders(user_id, COALESCE(parent_id, ''), name);
      CREATE INDEX idx_folders_user_parent ON folders(user_id, parent_id);

      ALTER TABLE files ADD COLUMN parent_id TEXT REFERENCES folders(id);
      CREATE INDEX idx_files_parent ON files(parent_id) WHERE parent_id IS NOT NULL;

      ALTER TABLE files ADD COLUMN trashed_at TEXT;
      CREATE INDEX idx_files_trashed ON files(trashed_at) WHERE trashed_at IS NOT NULL;

      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('upload_completed','share_used','quota_stale')),
        payload TEXT NOT NULL,
        read_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_notifications_user ON notifications(user_id, created_at);
      CREATE INDEX idx_notifications_unread ON notifications(user_id, read_at) WHERE read_at IS NULL;
    `);
    const violations = db.pragma('foreign_key_check', { simple: true });
    if (violations) {
      throw new Error('foreign_key_check failed after the folders/trash/notifications migration');
    }
  },
};

export const allMigrations: readonly Migration[] = [
  M0001_INFRASTRUCTURE,
  M0002_CORE_METADATA_SCHEMA,
  M0003_PROVIDER_CONNECTIONS,
  M0004_PROVIDER_ACCOUNT_ROOTS,
  M0005_CHUNK_PLACEMENT_OBJECT_KEY,
  M0006_UPLOAD_ENGINE,
  M0007_PLACEMENT_STATES,
  M0008_DOWNLOAD_ENGINE,
  M0009_SHARE_LINKS,
  M0010_SHARE_UNLOCK_GRANTS,
  M0011_QUOTA_SCOPE_AND_RECONCILE,
  M0012_S3_BUSINESS_TIER,
  M0013_MULTI_USER,
  M0014_FOLDERS_TRASH_NOTIFICATIONS,
];
