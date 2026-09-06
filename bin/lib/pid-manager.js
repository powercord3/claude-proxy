// PID manager — ALL process/pid logic lives here
//
// Used by:
//   - Gateway (anthropic-gateway.ts) → writePid(), registerCleanup()
//   - Launcher (proxy-launcher.js)   → readLock(), killPid(), killPortOccupant(), fetchHealth(), etc.

import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const PID_DIR = join(homedir(), ".claude-proxy");
const PID_FILE = join(PID_DIR, "proxy.pid");

// ── Write / Read / Remove lock ───────────────────────────────────────

/** Write lock: current process PID + timestamp */
export async function writePid() {
  await mkdir(PID_DIR, { recursive: true });
  await writeFile(PID_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8");
}

/** Read lock file → { pid, startedAt } or null */
export async function readLock() {
  try { return JSON.parse(await readFile(PID_FILE, "utf-8")); }
  catch { return null; }
}

/** Remove lock file (safe if already gone) */
export async function removeLock() {
  try { await unlink(PID_FILE); } catch {}
}

// ── Process checks ───────────────────────────────────────────────────

/** Is PID alive? (cross-platform, no shell commands) */
export function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

/** Fetch /healthz from the proxy on a given port */
export async function fetchHealth(port) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 2000);
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: c.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// ── Kill helpers ─────────────────────────────────────────────────────

/** SIGTERM → wait 3s → SIGKILL a specific PID, remove lock when dead */
export async function killPid(pid) {
  if (!isAlive(pid)) { await removeLock(); return true; }
  try { process.kill(pid, "SIGTERM"); } catch { await removeLock(); return true; }
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!isAlive(pid)) { await removeLock(); return true; }
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!isAlive(pid)) { await removeLock(); return true; }
  }
  return false;
}

/** Synchronous sleep. Replaces execSync("sleep"), which does not exist on Windows. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Find PIDs listening on a TCP port.
 * lsof is not present on Windows, so fall back to netstat there and parse the
 * PID column off LISTENING rows.
 */
export function findPortPids(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) return [];

  if (process.platform === "win32") {
    const out = execSync("netstat -ano -p tcp", { encoding: "utf-8" });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      // "  TCP    127.0.0.1:17870   0.0.0.0:0   LISTENING   1234"
      const cols = line.trim().split(/\s+/);
      const local = cols[1] || "";
      if (!local.endsWith(`:${p}`)) continue;
      const pid = Number(cols[cols.length - 1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(String(pid));
    }
    return [...pids];
  }

  return execSync(`lsof -ti:${p}`, { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
}

/** Kill whatever is listening on the port */
export function killPortOccupant(port) {
  try {
    const pids = findPortPids(port);
    if (pids.length === 0) return false;
    for (const p of pids) {
      try { process.kill(Number(p), "SIGTERM"); } catch {}
    }
    for (let i = 0; i < 20; i++) {
      const alive = pids.some(p => { try { process.kill(Number(p), 0); return true; } catch { return false; } });
      if (!alive) return true;
      sleepSync(100);
    }
    for (const p of pids) {
      try { process.kill(Number(p), "SIGKILL"); } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

// ── Gateway cleanup ──────────────────────────────────────────────────

/** Auto-remove PID file on exit/crash/signal (call from gateway only) */
export function registerCleanup() {
  const rm = () => { try { unlinkSync(PID_FILE); } catch {} };
  process.on("exit", rm);
  process.on("SIGINT", () => { rm(); exitSoon(); });
  process.on("SIGTERM", () => { rm(); exitSoon(); });
}

// `process.exit()` while a WebSocket handle is open aborts the process instead of exiting:
//
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
//
// Measured on Node 24 / Windows, 2026-09-06, both with the socket left open and with it closed
// in the same tick. Closing and exiting one tick later is clean. The codex WebSocket transport
// (adapters/providers/codex-ws.ts) holds pooled sockets open for up to 50 minutes, so from its
// introduction the ordinary SIGINT path could hit this.
//
// The damage is limited -- the `exit` handler above still runs first, so the PID file is
// removed either way -- but the process then dies with code 127, which a restart script reading
// the stop's exit status would take for a failed stop.
//
// So: yield one tick, letting libuv finish closing handles, and only then exit. The timer is
// unref'd, so if nothing else is holding the loop the process exits immediately on its own and
// this costs nothing. The 2s hard stop is there because a stuck handle must not turn a stop
// into a hang, which would be worse than the abort it replaces.
function exitSoon() {
  const t = setTimeout(() => process.exit(0), 2000);
  if (typeof t.unref === "function") t.unref();
}
