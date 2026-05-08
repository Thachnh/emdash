import type { ClientChannel } from 'ssh2';
import { err, ok, type Result } from '@shared/result';
import type { SshClientProxy } from '@main/core/ssh/ssh-client-proxy';
import { log } from '@main/lib/logger';
import { normalizeSignal } from './exit-signals';
import type { Pty, PtyDimensions, PtyExitInfo } from './pty';

export type Ssh2OpenError = {
  readonly kind: 'channel-open-failed';
  readonly message: string;
};

export interface Ssh2SpawnOptions extends PtyDimensions {
  id: string;
  command: string;
}

/** Backoff (ms) between retries when the server refuses a new channel — typically MaxSessions saturation. */
const CHANNEL_OPEN_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000];

export class Ssh2PtySession implements Pty {
  readonly id: string;

  constructor(
    id: string,
    private readonly channel: ClientChannel
  ) {
    this.id = id;
  }

  write(data: string): void {
    this.channel.write(data);
  }

  resize(cols: number, rows: number): void {
    try {
      this.channel.setWindow(rows, cols, 0, 0);
    } catch (err: unknown) {
      log.warn('Ssh2PtySession:resize failed', {
        cols,
        rows,
        error: String((err as Error)?.message ?? err),
      });
    }
  }

  kill(): void {
    try {
      this.channel.close();
    } catch {}
  }

  onData(handler: (data: string) => void): void {
    this.channel.on('data', (chunk: Buffer) => {
      handler(chunk.toString('utf-8'));
    });
  }

  onExit(handler: (info: PtyExitInfo) => void): void {
    this.channel.on('close', (exitCode: number | null, signal: string | null) => {
      handler({ exitCode: exitCode ?? undefined, signal: normalizeSignal(signal) });
    });
  }
}

function tryOpenSsh2PtyOnce(
  proxy: SshClientProxy,
  options: Ssh2SpawnOptions
): Promise<Result<Ssh2PtySession, Ssh2OpenError>> {
  const { id, command, cols, rows } = options;
  return new Promise((resolve) => {
    proxy.execPty(
      command,
      {
        pty: {
          term: 'xterm-256color',
          cols,
          rows,
          // width/height in pixels — set to 0, terminal uses cols/rows instead
          width: 0,
          height: 0,
        },
      },
      (e, channel) => {
        if (e) {
          const message = e instanceof Error ? e.message : String(e);
          return resolve(err({ kind: 'channel-open-failed', message }));
        }
        resolve(ok(new Ssh2PtySession(id, channel)));
      }
    );
  });
}

export async function openSsh2Pty(
  proxy: SshClientProxy,
  options: Ssh2SpawnOptions
): Promise<Result<Ssh2PtySession, Ssh2OpenError>> {
  let result = await tryOpenSsh2PtyOnce(proxy, options);
  for (const delay of CHANNEL_OPEN_RETRY_DELAYS_MS) {
    if (result.success) return result;
    log.warn('openSsh2Pty: SSH channel open refused, retrying', {
      id: options.id,
      delayMs: delay,
      error: result.error.message,
    });
    await new Promise<void>((r) => setTimeout(r, delay));
    result = await tryOpenSsh2PtyOnce(proxy, options);
  }
  return result;
}
