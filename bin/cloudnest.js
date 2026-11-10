#!/usr/bin/env node
/**
 * CloudNest Unified CLI & TUI Controller
 * Global CLI command: `cloudnest`
 */
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

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
  slate: '\x1b[38;2;148;163;184m',
  white: '\x1b[38;2;248;250;252m',
};

const args = process.argv.slice(2);
const command = (args[0] || '').toLowerCase();

function printHelp() {
  console.log(`
${C.bold}${C.brand}☁  CloudNest Unified Control CLI${C.reset}  ${C.dim}v0.1.0${C.reset}

${C.bold}USAGE:${C.reset}
  ${C.green}cloudnest${C.reset}                    Launch the interactive Terminal User Interface (TUI)
  ${C.green}cloudnest tui${C.reset}                Launch the interactive Terminal User Interface
  ${C.green}cloudnest config${C.reset}             Manage storage providers and cloud configurations
  ${C.green}cloudnest status${C.reset}             Check if server is active, port binding, and memory
  ${C.green}cloudnest start${C.reset} [flags]       Start the CloudNest backend server
  ${C.green}cloudnest stop${C.reset}               Gracefully stop the active CloudNest daemon
  ${C.green}cloudnest restart${C.reset}            Restart the running CloudNest service
  ${C.green}cloudnest reset-admin${C.reset}        Launch interactive admin password recovery tool
  ${C.green}cloudnest help${C.reset}               Display this manual and command references

${C.bold}START FLAGS:${C.reset}
  ${C.cyan}-d, --daemon${C.reset}         Run server in background as a system daemon
  ${C.cyan}-p, --port <port>${C.reset}    Specify HTTP port (default: 8787)

${C.dim}Documentation: https://github.com/cloudnest-open/CloudNest${C.reset}
`);
}

async function checkHealth(port = 8787) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 1200 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, data: JSON.parse(data) });
        } catch {
          resolve({ ok: res.statusCode === 200, data: null });
        }
      });
    });
    req.on('error', () => resolve({ ok: false, data: null }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, data: null }); });
  });
}

function findPid(port = 8787) {
  try {
    const out = execSync(`lsof -t -i :${port}`, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (out) {
      const pids = out.split('\n').filter(Boolean);
      return pids[0] || null;
    }
  } catch {}
  return null;
}

async function handleStatus() {
  const port = process.env.PORT || 8787;
  const pid = findPid(port);
  const health = await checkHealth(port);

  console.log(`\n${C.bold}${C.brand}☁  CloudNest Engine Status${C.reset}`);
  console.log(`${C.dim}───────────────────────────────────────────────────${C.reset}`);
  console.log(`  Engine State:   ${health.ok ? `${C.green}● ACTIVE / ONLINE${C.reset}` : `${C.red}○ STOPPED / OFFLINE${C.reset}`}`);
  console.log(`  Port:           ${C.cyan}${port} (TCP/HTTP)${C.reset}`);
  console.log(`  Process ID:     ${pid ? `${C.white}${pid}${C.reset}` : `${C.dim}none${C.reset}`}`);
  console.log(`  Web Dashboard:  ${C.white}http://127.0.0.1:${port}${C.reset}`);
  console.log(`  Data Directory: ${C.slate}${path.join(os.homedir(), '.local/share/CloudNest')}${C.reset}`);
  console.log(`${C.dim}───────────────────────────────────────────────────${C.reset}\n`);
}

async function handleStop() {
  const port = process.env.PORT || 8787;
  const pid = findPid(port);
  if (!pid) {
    console.log(`\n${C.amber}No active CloudNest process found on port ${port}.${C.reset}\n`);
    return;
  }
  process.stdout.write(`${C.dim}Stopping CloudNest instance (PID ${pid})...${C.reset} `);
  try {
    process.kill(parseInt(pid, 10), 'SIGTERM');
    console.log(`${C.green}Done.${C.reset}\n`);
  } catch {
    try {
      execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
      console.log(`${C.green}Done (SIGKILL).${C.reset}\n`);
    } catch (e) {
      console.log(`${C.red}Failed: ${e.message}${C.reset}\n`);
    }
  }
}

async function handleStart() {
  const isDaemon = args.includes('-d') || args.includes('--daemon');
  const portIdx = args.indexOf('-p') !== -1 ? args.indexOf('-p') : args.indexOf('--port');
  const port = portIdx !== -1 && args[portIdx + 1] ? args[portIdx + 1] : (process.env.PORT || 8787);

  const existingPid = findPid(port);
  if (existingPid) {
    console.log(`\n${C.amber}CloudNest is already running on port ${port} (PID ${existingPid}).${C.reset}`);
    console.log(`Access at: ${C.white}http://127.0.0.1:${port}${C.reset}\n`);
    return;
  }

  const serverEntry = path.join(rootDir, 'dist/server/src/index.js');
  if (!fs.existsSync(serverEntry)) {
    console.log(`\n${C.amber}Building production bundle first...${C.reset}`);
    execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });
  }

  if (isDaemon) {
    const logDir = path.join(os.homedir(), '.local/share/CloudNest');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'server.log');
    const out = fs.openSync(logFile, 'a');
    const err = fs.openSync(logFile, 'a');

    const child = spawn(process.execPath, [serverEntry], {
      cwd: rootDir,
      detached: true,
      stdio: ['ignore', out, err],
      env: { ...process.env, PORT: String(port) },
    });
    child.unref();

    console.log(`\n${C.green}✔ CloudNest started as background daemon (PID ${child.pid})${C.reset}`);
    console.log(`  Local URL:  ${C.white}http://127.0.0.1:${port}${C.reset}`);
    console.log(`  Logs file:  ${C.slate}${logFile}${C.reset}\n`);
  } else {
    console.log(`\n${C.brand}Starting CloudNest server on :${port}... (Press Ctrl+C to stop)${C.reset}\n`);
    const child = spawn(process.execPath, [serverEntry], {
      cwd: rootDir,
      stdio: 'inherit',
      env: { ...process.env, PORT: String(port) },
    });
    child.on('exit', (code) => {
      process.exit(code || 0);
    });
  }
}

function launchTui(initialTab = 1) {
  const tuiScript = path.join(rootDir, 'scripts/tui.js');
  const child = spawn(process.execPath, [tuiScript], {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, CLOUDNEST_TUI_TAB: String(initialTab) },
  });
  child.on('exit', (code) => {
    process.exit(code || 0);
  });
}

async function main() {
  switch (command) {
    case '':
    case 'tui':
      launchTui(1);
      break;
    case 'config':
    case 'accounts':
      launchTui(2); // Jump directly to Accounts / Configuration tab
      break;
    case 'status':
      await handleStatus();
      break;
    case 'start':
      await handleStart();
      break;
    case 'stop':
      await handleStop();
      break;
    case 'restart':
      await handleStop();
      await new Promise((r) => setTimeout(r, 600));
      await handleStart();
      break;
    case 'reset-admin':
      {
        const resetScript = path.join(rootDir, 'dist/server/src/scripts/reset-admin.js');
        execSync(`node "${resetScript}"`, { cwd: rootDir, stdio: 'inherit' });
      }
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.log(`\n${C.red}Unknown command: "${command}"${C.reset}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n${C.red}CLI Error:${C.reset}`, err.message);
  process.exit(1);
});
