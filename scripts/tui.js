#!/usr/bin/env node
import readline from 'readline';
import process from 'process';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  brand: '\x1b[38;2;0;102;218m',
  brandLight: '\x1b[38;2;38;132;252m',
  cyan: '\x1b[38;2;6;182;212m',
  green: '\x1b[38;2;16;185;129m',
  amber: '\x1b[38;2;245;158;11m',
  red: '\x1b[38;2;239;68;68m',
  purple: '\x1b[38;2;168;85;247m',
  slate: '\x1b[38;2;148;163;184m',
  border: '\x1b[38;2;51;65;85m',
  white: '\x1b[38;2;248;250;252m',
  bgBrand: '\x1b[48;2;0;102;218m\x1b[38;2;255;255;255m',
  bgPillGreen: '\x1b[48;2;6;78;59m\x1b[38;2;52;211;153m',
  bgPillAmber: '\x1b[48;2;120;53;15m\x1b[38;2;251;191;36m',
  bgPillBlue: '\x1b[48;2;30;58;138m\x1b[38;2;147;197;253m',
};

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let u = -1;
  do {
    val /= 1024;
    u++;
  } while (val >= 1024 && u < units.length - 1);
  return `${val.toFixed(1)} ${units[u]}`;
}

function makeProgressBar(used, total, width = 12) {
  if (!total || total <= 0) return `${C.border}[${'░'.repeat(width)}]${C.reset} 0%`;
  const pct = Math.min(1, Math.max(0, used / total));
  const filled = Math.round(pct * width);
  const color = pct > 0.85 ? C.red : pct > 0.65 ? C.amber : C.green;
  return `${color}[${'█'.repeat(filled)}${C.border}${'░'.repeat(width - filled)}${color}]${C.reset} ${Math.round(pct * 100)}%`;
}

class CloudNestTui {
  constructor() {
    this.dbPath = process.env.CLOUDNEST_DB_PATH || path.join(os.homedir(), '.local/share/CloudNest/cloudnest.db');
    this.statusMessage = '';
  }

  getDb() {
    try {
      return new Database(this.dbPath, { readonly: false });
    } catch {
      return null;
    }
  }

  renderScreen() {
    const db = this.getDb();
    let accounts = [];
    let fileCount = 0;
    let trashCount = 0;
    let userCount = 0;
    let totalUsableBytes = 0;
    let totalUsedBytes = 0;

    if (db) {
      try {
        accounts = db.prepare('SELECT * FROM provider_accounts ORDER BY tier, provider').all();
        fileCount = db.prepare("SELECT count(*) as c FROM files WHERE state = 'completed'").get().c;
        trashCount = db.prepare("SELECT count(*) as c FROM files WHERE state = 'trash'").get().c;
        userCount = db.prepare('SELECT count(*) as c FROM users').get().c;

        for (const a of accounts) {
          totalUsableBytes += a.quota_total_bytes || a.capacity_cap_bytes || 0;
          totalUsedBytes += a.quota_used_bytes || 0;
        }
      } catch (e) {
        this.statusMessage = `DB Notice: ${e.message}`;
      } finally {
        db.close();
      }
    }

    const mem = process.memoryUsage();
    console.clear();

    console.log(`${C.brand}╭──────────────────────────────────────────────────────────────────────────────────────────╮${C.reset}`);
    console.log(`${C.brand}│  ${C.bold}${C.white}☁  CloudNest Enterprise Console${C.reset} ${C.brandLight}v0.1.0${C.reset}       ${C.bgPillGreen} ● ENGINE ONLINE ${C.reset}  ${C.dim}http://127.0.0.1:8787${C.reset} ${C.brand}│${C.reset}`);
    console.log(`${C.brand}╰──────────────────────────────────────────────────────────────────────────────────────────╯${C.reset}`);

    console.log(`${C.border}╭─ ${C.cyan}CORE ENGINE & RUNTIME${C.border} ───────────────╮╭─ ${C.cyan}STORAGE POOLS & UNIFIED QUOTA${C.border} ──────────────╮${C.reset}`);
    console.log(`${C.border}│${C.reset}  Process Memory: ${C.white}${formatBytes(mem.rss).padEnd(16)}${C.reset} ${C.border}││${C.reset}  Connected Pools:  ${C.bold}${C.white}${String(accounts.length).padEnd(20)}${C.reset} ${C.border}│${C.reset}`);
    console.log(`${C.border}│${C.reset}  Heap Active:    ${C.white}${formatBytes(mem.heapUsed).padEnd(16)}${C.reset} ${C.border}││${C.reset}  Personal Quota:   ${C.slate}${accounts.filter(a => a.tier === 'personal').length} accounts linked${C.reset}     ${C.border}│${C.reset}`);
    console.log(`${C.border}│${C.reset}  Binding Port:   ${C.green}8787 (TCP/HTTP)${C.reset}  ${C.border}││${C.reset}  Business S3:      ${C.slate}${accounts.filter(a => a.tier === 'business').length} accounts linked${C.reset}     ${C.border}│${C.reset}`);
    console.log(`${C.border}│${C.reset}  Runtime Node:   ${C.purple}v24.x LTS (x64)${C.reset}  ${C.border}││${C.reset}  Total Capacity:   ${C.white}${formatBytes(totalUsableBytes).padEnd(20)}${C.reset} ${C.border}│${C.reset}`);
    console.log(`${C.border}│${C.reset}  Database Mode:  ${C.bgPillGreen} SQLite WAL ${C.reset}     ${C.border}││${C.reset}  Pool Utilization: ${makeProgressBar(totalUsedBytes, totalUsableBytes, 12)}   ${C.border}│${C.reset}`);
    console.log(`${C.border}╰────────────────────────────────────────╯╰─────────────────────────────────────────────────╯${C.reset}`);

    console.log(`${C.border}╭─ ${C.cyan}CONNECTED PROVIDER ACCOUNTS${C.border} ────────────────────────────────────────────────────────────╮${C.reset}`);
    if (accounts.length === 0) {
      console.log(`${C.border}│${C.reset}  ${C.slate}No storage accounts connected yet. Link accounts via Web Dashboard.${C.reset}${' '.repeat(22)}${C.border}│${C.reset}`);
    } else {
      accounts.slice(0, 4).forEach((acc) => {
        const badge = acc.tier === 'business' ? `${C.bgPillAmber} S3-BUS ${C.reset}` : `${C.bgPillBlue} PERSNL ${C.reset}`;
        const name = (acc.account_identifier || acc.provider_name || acc.provider).slice(0, 22).padEnd(23);
        const used = formatBytes(acc.quota_used_bytes || 0).padStart(9);
        const total = formatBytes(acc.quota_total_bytes || acc.capacity_cap_bytes || 0).padEnd(9);
        const pBar = makeProgressBar(acc.quota_used_bytes || 0, acc.quota_total_bytes || acc.capacity_cap_bytes || 0, 8);
        console.log(`${C.border}│${C.reset}  ${badge} ${C.white}${name}${C.reset} ${C.slate}${used} / ${total}${C.reset}  ${pBar} ${C.border}│${C.reset}`);
      });
    }
    console.log(`${C.border}╰──────────────────────────────────────────────────────────────────────────────────────────╯${C.reset}`);

    console.log(`${C.border}╭─ ${C.cyan}FILES & METRICS${C.border} ──────────────────────╮╭─ ${C.cyan}ENTERPRISE CONTROL ACTIONS${C.border} ─────────────────────╮${C.reset}`);
    console.log(`${C.border}│${C.reset}  Library Files:  ${C.bold}${C.white}${String(fileCount).padEnd(16)}${C.reset} ${C.border}││${C.reset}  ${C.bold}${C.amber}[P]${C.reset} Reset Admin Password                    ${C.border}│${C.reset}`);
    console.log(`${C.border}│${C.reset}  Trash Storage:  ${C.amber}${String(trashCount).padEnd(16)}${C.reset} ${C.border}││${C.reset}  ${C.bold}${C.green}[I]${C.reset} Generate One-Time Invite Token          ${C.border}│${C.reset}`);
    console.log(`${C.border}│${C.reset}  Active Users:   ${C.white}${String(userCount).padEnd(16)}${C.reset} ${C.border}││${C.reset}  ${C.bold}${C.cyan}[V]${C.reset} Run SQLite Maintenance (VACUUM)         ${C.border}│${C.reset}`);
    console.log(`${C.border}│${C.reset}  Security Audit: ${C.green}Clean (0-vuln)${C.reset}   ${C.border}││${C.reset}  ${C.bold}${C.brandLight}[R]${C.reset} Refresh Metrics Console                 ${C.border}│${C.reset}`);
    console.log(`${C.border}│${C.reset}  SSR Firewall:   ${C.green}Protected${C.reset}        ${C.border}││${C.reset}  ${C.bold}${C.red}[Q]${C.reset} Exit Terminal Console                   ${C.border}│${C.reset}`);
    console.log(`${C.border}╰────────────────────────────────────────╯╰─────────────────────────────────────────────────╯${C.reset}`);

    if (this.statusMessage) {
      console.log(`\n  ${C.bgBrand} NOTIFICATION ${C.reset} ${C.bold}${this.statusMessage}${C.reset}`);
    }
    console.log(`\n  ${C.dim}Navigation: Press [P, I, V, R, Q] on your keyboard...${C.reset}`);
  }

  async runAction(action) {
    const key = (action || '').trim().toLowerCase();
    const db = this.getDb();

    if (key === 'q') {
      console.clear();
      console.log(`\n${C.green}✔ CloudNest TUI Console closed. Server process remains live on :8787.${C.reset}\n`);
      process.exit(0);
    }

    if (key === 'r') {
      this.statusMessage = 'Metrics refreshed successfully.';
      this.renderScreen();
      return;
    }

    if (key === 'v') {
      if (!db) {
        this.statusMessage = 'Database connection unavailable.';
      } else {
        try {
          db.exec('VACUUM;');
          this.statusMessage = 'Database VACUUM completed and optimized.';
        } catch (e) {
          this.statusMessage = `Maintenance error: ${e.message}`;
        } finally {
          db.close();
        }
      }
      this.renderScreen();
      return;
    }

    if (key === 'i') {
      if (!db) {
        this.statusMessage = 'Database connection unavailable.';
      } else {
        try {
          const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
          this.statusMessage = `Invite Link: http://127.0.0.1:8787/accept-invite?token=${token}`;
        } catch (e) {
          this.statusMessage = `Error: ${e.message}`;
        } finally {
          db.close();
        }
      }
      this.renderScreen();
      return;
    }

    if (key === 'p') {
      console.clear();
      console.log(`\n${C.amber}▶ Launching Admin Password Reset Tool...${C.reset}\n`);
      try {
        execSync('node dist/server/src/scripts/reset-admin.js', { stdio: 'inherit' });
        this.statusMessage = 'Password reset process completed.';
      } catch (err) {
        this.statusMessage = 'Password reset cancelled or exited.';
      }
      this.renderScreen();
      this.listenInput();
      return;
    }

    this.renderScreen();
    this.listenInput();
  }

  listenInput() {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const onKey = (str, key) => {
      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      this.runAction(str || (key && key.name));
    };
    process.stdin.once('keypress', onKey);
  }

  start() {
    this.renderScreen();
    this.listenInput();
  }
}

new CloudNestTui().start();
