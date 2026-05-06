import { type SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { FileSystemError } from '@main/core/fs/types';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { log } from '@main/lib/logger';
import { quoteShellArg } from '@main/utils/shellEscape';
import type { ClientId, ProjectKey } from '@shared/remote-sync';
import {
  clientsDir,
  manifestPath,
  manifestTmpPath,
  projectDir,
  snapshotPath,
  snapshotTmpPath,
} from './remote-sync-paths';
import {
  parseManifest,
  parseSnapshot,
  type ClientSnapshot,
  type Manifest,
} from './remote-sync-schema';

export type ClaimManifestResult =
  | { kind: 'won'; manifest: Manifest }
  | { kind: 'lost'; manifest: Manifest };

export class RemoteSyncStore {
  // Cache one SshFileSystem for the lifetime of the store so we don't open
  // a new SFTP channel per operation. Each SshFileSystem caches its own SFTP
  // wrapper on first use; without this, sync leaked channels every cycle and
  // saturated the SSH server's MaxSessions limit.
  private readonly fs: SshFileSystem;

  constructor(
    private readonly proxy: SshClientProxy,
    private readonly ctx: SshExecutionContext,
    private readonly home: string,
    private readonly key: ProjectKey
  ) {
    this.fs = new SshFileSystem(this.proxy, `${this.home.replace(/\/$/, '')}/.emdash/sync`);
  }

  async ensureDirs(): Promise<void> {
    const projDir = projectDir(this.home, this.key);
    const cliDir = clientsDir(this.home, this.key);
    await this.ctx.exec('sh', [
      '-c',
      `mkdir -p ${quoteShellArg(projDir)} ${quoteShellArg(cliDir)}`,
    ]);
  }

  async readManifest(): Promise<Manifest | null> {
    const fs = this.fs;
    try {
      const result = await fs.read(`${this.key}/manifest.json`);
      const parsed = parseManifest(JSON.parse(result.content));
      if (!parsed.success) {
        log.warn('remote-sync: manifest parse failed', { key: this.key, error: parsed.error });
        return null;
      }
      return parsed.data;
    } catch (e) {
      if (isNotFoundError(e)) return null;
      throw e;
    }
  }

  /**
   * Atomically claim the manifest with our candidate manifest. Uses
   * `mv -n` (no-clobber): if the target exists, the rename is a no-op
   * and we re-read the winning manifest.
   */
  async claimManifest(candidate: Manifest): Promise<ClaimManifestResult> {
    const fs = this.fs;
    const tmpRel = `${this.key}/manifest.json.tmp`;
    const tmpAbs = manifestTmpPath(this.home, this.key);
    const finalAbs = manifestPath(this.home, this.key);

    await fs.write(tmpRel, JSON.stringify(candidate, null, 2));
    await this.ctx.exec('sh', [
      '-c',
      `mv -n ${quoteShellArg(tmpAbs)} ${quoteShellArg(finalAbs)} 2>/dev/null; rm -f ${quoteShellArg(tmpAbs)}`,
    ]);

    const winning = await this.readManifest();
    if (!winning) {
      throw new Error('remote-sync: manifest disappeared after claim attempt');
    }
    if (winning.canonicalProjectId === candidate.canonicalProjectId) {
      return { kind: 'won', manifest: winning };
    }
    return { kind: 'lost', manifest: winning };
  }

  async listClientSnapshotIds(): Promise<ClientId[]> {
    const dir = clientsDir(this.home, this.key);
    try {
      const { stdout } = await this.ctx.exec('sh', [
        '-c',
        `ls -1 ${quoteShellArg(dir)} 2>/dev/null || true`,
      ]);
      return stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.endsWith('.json') && !l.endsWith('.tmp.json'))
        .map((l) => l.replace(/\.json$/, ''));
    } catch (e) {
      log.warn('remote-sync: listClientSnapshotIds failed', { key: this.key, error: String(e) });
      return [];
    }
  }

  async readSnapshot(clientId: ClientId): Promise<ClientSnapshot | null> {
    const fs = this.fs;
    const rel = `${this.key}/clients/${clientId}.json`;
    try {
      const { content } = await fs.read(rel);
      const parsed = parseSnapshot(JSON.parse(content));
      if (!parsed.success) {
        log.warn('remote-sync: snapshot parse failed', {
          key: this.key,
          clientId,
          error: parsed.error,
        });
        return null;
      }
      return parsed.data;
    } catch (e) {
      if (isNotFoundError(e)) return null;
      log.warn('remote-sync: readSnapshot failed', { key: this.key, clientId, error: String(e) });
      return null;
    }
  }

  /**
   * Atomically write our own client snapshot using SFTP-write to .tmp + `mv -f`.
   */
  async writeOwnSnapshot(snapshot: ClientSnapshot): Promise<void> {
    const fs = this.fs;
    const tmpRel = `${this.key}/clients/${snapshot.clientId}.json.tmp`;
    const tmpAbs = snapshotTmpPath(this.home, this.key, snapshot.clientId);
    const finalAbs = snapshotPath(this.home, this.key, snapshot.clientId);

    await fs.write(tmpRel, JSON.stringify(snapshot, null, 2));
    await this.ctx.exec('sh', ['-c', `mv -f ${quoteShellArg(tmpAbs)} ${quoteShellArg(finalAbs)}`]);
  }
}

function isNotFoundError(e: unknown): boolean {
  return e instanceof FileSystemError && e.code === 'NOT_FOUND';
}
