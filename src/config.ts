/**
 * State file discovery for ghax.
 *
 * Resolution:
 *   1. GHAX_STATE_FILE env → derive stateDir from parent
 *   2. git rev-parse --show-toplevel → <root>/.ghax/ghax.json
 *   3. cwd fallback (non-git environments)
 *
 * The CLI resolves this and passes GHAX_STATE_FILE to the spawned daemon.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

export interface GhaxConfig {
  projectDir: string;
  stateDir: string;
  stateFile: string;
  consoleLog: string;
  networkLog: string;
  daemonLog: string;
}

export interface DaemonState {
  pid: number;
  port: number;
  browserUrl: string;
  browserKind: 'edge' | 'chrome' | 'chromium' | 'brave' | 'arc';
  attachedAt: string;
  cwd: string;
}

export function getGitRoot(cwd: string = process.cwd()): string | null {
  // Uses Node's child_process so this file works under both Bun (tests) and
  // Node (daemon runtime). Previously called Bun.spawnSync which would crash
  // if the daemon ever ran without GHAX_STATE_FILE pre-set by the Rust CLI.
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
      encoding: 'utf-8',
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
): GhaxConfig {
  let stateFile: string;
  let stateDir: string;
  let projectDir: string;

  if (env.GHAX_STATE_FILE) {
    stateFile = env.GHAX_STATE_FILE;
    stateDir = path.dirname(stateFile);
    projectDir = path.dirname(stateDir);
  } else if (env.GHAX_GLOBAL === '1') {
    projectDir = os.homedir();
    stateDir = path.join(projectDir, '.ghax');
    stateFile = path.join(stateDir, 'ghax.json');
  } else {
    projectDir = getGitRoot() || process.cwd();
    stateDir = path.join(projectDir, '.ghax');
    stateFile = path.join(stateDir, 'ghax.json');
  }

  return {
    projectDir,
    stateDir,
    stateFile,
    consoleLog: path.join(stateDir, 'ghax-console.log'),
    networkLog: path.join(stateDir, 'ghax-network.log'),
    daemonLog: path.join(stateDir, 'ghax-daemon.log'),
  };
}

export function ensureStateDir(cfg: GhaxConfig): void {
  try {
    fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  } catch (err: any) {
    if (err.code === 'EACCES') {
      throw new Error(`Cannot create ${cfg.stateDir}: permission denied`);
    }
    if (err.code === 'ENOTDIR') {
      throw new Error(`Cannot create ${cfg.stateDir}: a file exists at that path`);
    }
    throw err;
  }

  const gitignorePath = path.join(cfg.projectDir, '.gitignore');
  try {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.match(/^\.ghax\/?$/m)) {
      const sep = content.endsWith('\n') ? '' : '\n';
      fs.appendFileSync(gitignorePath, `${sep}.ghax/\n`);
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      // best-effort — log to daemon log later
    }
  }
}

export function readState(cfg: GhaxConfig): DaemonState | null {
  try {
    return JSON.parse(fs.readFileSync(cfg.stateFile, 'utf-8')) as DaemonState;
  } catch {
    return null;
  }
}

export function writeState(cfg: GhaxConfig, state: DaemonState): void {
  fs.writeFileSync(cfg.stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function clearState(cfg: GhaxConfig): void {
  try {
    fs.unlinkSync(cfg.stateFile);
  } catch {
    // ignore
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Daemon registry (plan 11, phase 1): one file per live daemon under
 * `~/.ghax/daemons/<pid>.json`, so a CLI whose cwd resolves to a different
 * state file can still find the daemon an agent attached from elsewhere.
 * The daemon writes its entry once it's listening and removes it on exit;
 * readers (crates/cli/src/state.rs) drop entries whose pid is dead, which
 * covers SIGKILL. `GHAX_DAEMON_REGISTRY` moves the directory (tests).
 */
export interface DaemonRegistryEntry {
  pid: number;
  port: number;
  stateFile: string;
  cwd: string;
  browserKind: string;
  bridgePort: number | null;
  startedAt: string;
}

export function daemonRegistryDir(env: Record<string, string | undefined> = process.env): string {
  return env.GHAX_DAEMON_REGISTRY || path.join(os.homedir(), '.ghax', 'daemons');
}

export function registerDaemon(
  entry: DaemonRegistryEntry,
  dir: string = daemonRegistryDir(),
  // Injectable so a test can observe where the bytes land first.
  writeFile: (f: string, data: string, opts: fs.WriteFileOptions) => void = fs.writeFileSync,
): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${entry.pid}.json`);
  // Write beside the target and rename: readers (state.rs) must never see a
  // half-written entry, and the temp name is not `.json` so they skip it.
  const tmp = path.join(dir, `.${entry.pid}.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFile(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
  return file;
}

export function unregisterDaemon(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone (a reader pruned it, or the home dir moved) — nothing to undo.
  }
}
