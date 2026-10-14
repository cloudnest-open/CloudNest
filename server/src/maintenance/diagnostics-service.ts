import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

/**
 * Diagnostics with redaction (M12.d).
 *
 * The output of this module is designed to be copy-pasteable into a bug report.
 * The redactor replaces the credential shapes listed in SECRET_PATTERNS below —
 * dot- and single-segment base64url blobs (`eyJ…`), long mixed-case
 * base64url/alphanumeric bearer tokens, provider token prefixes, `Bearer`,
 * `*_token`, `client_secret` and `password` assignments, session identifiers
 * (`cloudnest.sid=…`, `connect.sid=…`, `session=…`), secret-bearing URLs and
 * absolute home paths — before the text can leave the process.
 *
 * It is pattern-based, not a guarantee: an arbitrary secret that does not match
 * one of those shapes (for example a short or word-like passphrase, or a secret
 * used with no recognisable name next to it) passes through unchanged.
 */

const REDACTED = '[redacted]';

/** Patterns for values that must never appear in diagnostics. */
const SECRET_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  // a single-segment base64url blob that starts with the base64 of `{"` — the
  // shape of a Cloudflare tunnel runtime token, which is NOT dot-separated
  /eyJ[A-Za-z0-9_-]{40,}/g,
  /ya29\.[A-Za-z0-9_-]{10,}/g, // Google access token
  /sl\.[A-Za-z0-9_-]{20,}/g, // Dropbox token
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\bclient_secret["':=\s]+[A-Za-z0-9._~+/-]{8,}/gi,
  /\baccess_token["':=\s]+[A-Za-z0-9._~+/-]{8,}/gi,
  /\brefresh_token["':=\s]+[A-Za-z0-9._~+/-]{8,}/gi,
  /\bpassword["':=\s]+[^\s"',}]{6,}/gi,
  // session identifiers: name, separator, value, with the quotes of a JSON body allowed
  // `%` is included because express-session cookie values are URL-encoded (s%3A…)
  /\bcloudnest\.sid["']?\s*[:=]\s*["']?[A-Za-z0-9._~%+/-]{8,}/gi,
  /\bconnect\.sid["']?\s*[:=]\s*["']?[A-Za-z0-9._~%+/-]{8,}/gi,
  /\bsession(?:id)?["']?\s*[:=]\s*["']?[A-Za-z0-9._~%+/-]{12,}=*/gi,
  // a long mixed-case base64url/alphanumeric run with no separators (tunnel and
  // API tokens). The minimum length plus the composition lookaheads below keep
  // ordinary prose, lowercase identifiers (integrity_check, foreign_key_check)
  // and plain numbers out of the redactor.
  /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]+=*/g,
  // a temporary provider download URL (pCloud/Graph style) is a bearer secret
  /https?:\/\/[^\s"']*[?&](?:access_token|token|sig|signature|download_token)=[^\s"'&]+/gi,
];

/** Replace every fragment matching a SECRET_PATTERNS credential shape. */
export function redact(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  // never echo an arbitrary local path beyond the app's own data directory
  output = output.replace(/(?:\/home\/|\/Users\/|C:\\Users\\)[^\s"']*/g, (match) => {
    const base = path.basename(match);
    return `${'…'}${path.sep}${base}`;
  });
  return output;
}

/**
 * Apply the redactor to every string in a structured value. `capabilities` is
 * the one report field whose contents are not enumerated here, so it is walked
 * and passed through the same redactor; array elements and object values are
 * covered, not only top-level strings.
 */
export function redactStructured(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((entry) => redactStructured(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactStructured(entry)]));
  }
  return value;
}

export interface DiagnosticsReport {
  generatedAt: string;
  appVersion: string;
  runtime: {
    node: string;
    platform: string;
    arch: string;
    pid: number;
    uptimeSeconds: number;
    memoryMb: number;
  };
  storage: {
    dataDir: string;
    databaseBytes: number;
    walPresent: boolean;
    backupsPresent: number;
  };
  database: {
    integrityCheck: string;
    foreignKeyCheckClean: boolean;
    schemaMigrations: number;
    counts: Record<string, number>;
  };
  capabilities: Record<string, unknown>;
  notes: string[];
}

export class DiagnosticsService {
  constructor(
    private readonly db: Database.Database,
    private readonly dataDir: string,
    private readonly appVersion: string,
    private readonly capabilities: Record<string, unknown>,
  ) {}

  /** Build a redacted report. Callers must not pass credentials in `extra`. */
  build(): DiagnosticsReport {
    const dbPath = path.join(this.dataDir, 'cloudnest.db');
    const integrity = this.db.pragma('integrity_check', { simple: true }) as string;
    const violations = this.db.pragma('foreign_key_check');
    const migrations = (this.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n;
    const countOf = (table: string): number => {
      try {
        return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      } catch {
        return -1;
      }
    };
    const backupRoot = path.join(this.dataDir, 'backups');
    return {
      generatedAt: new Date().toISOString(),
      appVersion: this.appVersion,
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      },
      storage: {
        dataDir: redact(this.dataDir),
        databaseBytes: fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0,
        walPresent: fs.existsSync(`${dbPath}-wal`),
        backupsPresent: fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot).length : 0,
      },
      database: {
        integrityCheck: integrity,
        foreignKeyCheckClean: Array.isArray(violations) ? violations.length === 0 : !violations,
        schemaMigrations: migrations,
        counts: {
          files: countOf('files'),
          chunks: countOf('file_chunks'),
          placements: countOf('chunk_placements'),
          providerAccounts: countOf('provider_accounts'),
          shareLinks: countOf('share_links'),
          uploadJobs: countOf('transfer_jobs'),
          auditEvents: countOf('audit_events'),
        },
      },
      capabilities: redactStructured(this.capabilities) as Record<string, unknown>,
      notes: [
        'This report is pattern-redacted: values matching known credential, token, session-identifier and secret-bearing-URL shapes are replaced before output. It is not a guarantee — an unrecognised secret shape can pass through, so never paste this into a public issue without reading it first.',
        'Provider capability status distinguishes mock-tested, live-tested, blocked and experimental.',
        'The credential-encryption key is not included here, and must be backed up separately by the owner.',
      ],
    };
  }

  /** The exact text the Copy button places on the clipboard. */
  toText(report: DiagnosticsReport): string {
    return redact(JSON.stringify(report, null, 2));
  }
}
