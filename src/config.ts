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
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 2_000,
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim() || null;
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
