import { eq } from 'drizzle-orm';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { projectManager } from '@main/core/projects/project-manager';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import { taskManager } from '@main/core/tasks/task-manager';
import { db } from '@main/db/client';
import { projects } from '@main/db/schema';
import { events } from '@main/lib/events';
import type { IDisposable, IInitializable } from '@main/lib/lifecycle';
import { log } from '@main/lib/logger';
import { remoteSyncActiveSessionsChannel } from '@shared/events/remoteSyncEvents';
import { remoteSyncEngine } from './remote-sync-engine';
import { getActiveSessionIds } from './tmux-active-discovery';

const PULL_INTERVAL_MS = 20_000;
const SNAPSHOT_PUSH_INTERVAL_MS = 15_000;
const TMUX_POLL_INTERVAL_MS = 15_000;
const ACTIVATION_RETRY_MS = 30_000;

export class RemoteSyncScheduler implements IInitializable, IDisposable {
  private _unsubscribes: Array<() => void> = [];
  private readonly _intervals = new Map<string, Array<ReturnType<typeof setInterval>>>();
  private readonly _activationRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _enabled = !envFlagDisabled();

  initialize(): void {
    if (!this._enabled) {
      log.info('remote-sync: disabled via EMDASH_DISABLE_REMOTE_SYNC');
      return;
    }
    this._unsubscribes = [
      projectManager.on('projectOpened', (projectId) => {
        void this.onProjectOpened(projectId);
      }),
      projectManager.on('projectClosed', (projectId) => {
        this.onProjectClosed(projectId);
      }),
      taskManager.hooks.on('task:provisioned', ({ projectId }) => {
        if (remoteSyncEngine.isActive(projectId)) remoteSyncEngine.schedulePush(projectId);
      }),
      taskManager.hooks.on('task:torn-down', ({ projectId }) => {
        if (remoteSyncEngine.isActive(projectId)) remoteSyncEngine.schedulePush(projectId);
      }),
    ];
  }

  dispose(): void {
    for (const unsub of this._unsubscribes) unsub();
    this._unsubscribes = [];
    for (const handles of this._intervals.values()) {
      for (const h of handles) clearInterval(h);
    }
    this._intervals.clear();
    for (const t of this._activationRetries.values()) clearTimeout(t);
    this._activationRetries.clear();
  }

  private async onProjectOpened(projectId: string): Promise<void> {
    const isSsh = await this._isSshProject(projectId);
    if (!isSsh) return;
    await this._tryActivate(projectId);
  }

  private async _tryActivate(projectId: string): Promise<void> {
    if (this._intervals.has(projectId)) return; // already active

    const activated = await remoteSyncEngine.activate(projectId);
    if (!activated.success) {
      log.warn('remote-sync: failed to activate engine, will retry', {
        projectId,
        error: activated.error,
        retryInMs: ACTIVATION_RETRY_MS,
      });
      this._scheduleActivationRetry(projectId);
      return;
    }

    // Activation succeeded — clear any pending retry and start the steady-state intervals.
    const pending = this._activationRetries.get(projectId);
    if (pending) {
      clearTimeout(pending);
      this._activationRetries.delete(projectId);
    }

    void remoteSyncEngine.pull(projectId);
    void remoteSyncEngine.push(projectId, { immediate: true });
    void this._pollActiveSessions(projectId);

    const handles: Array<ReturnType<typeof setInterval>> = [
      setInterval(() => {
        void remoteSyncEngine.pull(projectId);
      }, PULL_INTERVAL_MS),
      setInterval(() => {
        void remoteSyncEngine.push(projectId, { immediate: true });
      }, SNAPSHOT_PUSH_INTERVAL_MS),
      setInterval(() => {
        void this._pollActiveSessions(projectId);
      }, TMUX_POLL_INTERVAL_MS),
    ];
    this._intervals.set(projectId, handles);
  }

  private _scheduleActivationRetry(projectId: string): void {
    const existing = this._activationRetries.get(projectId);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this._activationRetries.delete(projectId);
      void this._tryActivate(projectId);
    }, ACTIVATION_RETRY_MS);
    this._activationRetries.set(projectId, handle);
  }

  private onProjectClosed(projectId: string): void {
    const handles = this._intervals.get(projectId) ?? [];
    for (const h of handles) clearInterval(h);
    this._intervals.delete(projectId);
    const pending = this._activationRetries.get(projectId);
    if (pending) clearTimeout(pending);
    this._activationRetries.delete(projectId);
    remoteSyncEngine.deactivate(projectId);
  }

  private async _isSshProject(projectId: string): Promise<boolean> {
    const [row] = await db
      .select({ wp: projects.workspaceProvider })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row?.wp === 'ssh';
  }

  private async _pollActiveSessions(projectId: string): Promise<void> {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project?.sshConnectionId) return;
    try {
      const proxy = await sshConnectionManager.connect(project.sshConnectionId);
      const ctx = new SshExecutionContext(proxy);
      const ids = await getActiveSessionIds(ctx);
      events.emit(remoteSyncActiveSessionsChannel, {
        projectId,
        activeSessionIds: Array.from(ids),
      });
    } catch (e) {
      log.warn('remote-sync: tmux poll failed', { projectId, error: String(e) });
    }
  }
}

export const remoteSyncScheduler = new RemoteSyncScheduler();

function envFlagDisabled(): boolean {
  const v = process.env.EMDASH_DISABLE_REMOTE_SYNC;
  return v === '1' || v === 'true';
}
