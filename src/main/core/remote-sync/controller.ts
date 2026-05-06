import { eq } from 'drizzle-orm';
import { createRPCController } from '@shared/ipc/rpc';
import type { RemoteSyncError, RemoteSyncStatus } from '@shared/remote-sync';
import { err, ok, type Result } from '@shared/result';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { sshConnectionManager } from '@main/core/ssh/ssh-connection-manager';
import { db } from '@main/db/client';
import { projects } from '@main/db/schema';
import { remoteSyncEngine } from './remote-sync-engine';
import { getActiveSessionIds } from './tmux-active-discovery';

async function triggerSync(projectId: string): Promise<Result<RemoteSyncStatus, RemoteSyncError>> {
  if (!remoteSyncEngine.isActive(projectId)) return err({ type: 'project-not-open' });
  const pulled = await remoteSyncEngine.pull(projectId);
  if (!pulled.success) return err(toRemoteSyncError(pulled.error));
  await remoteSyncEngine.push(projectId, { immediate: true });
  const status = remoteSyncEngine.getStatus(projectId);
  if (!status) return err({ type: 'project-not-open' });
  return ok(status);
}

function getSyncStatus(projectId: string): RemoteSyncStatus | null {
  return remoteSyncEngine.getStatus(projectId);
}

async function getActiveSessionIdsForProject(
  projectId: string
): Promise<Result<{ ids: string[] }, RemoteSyncError>> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return err({ type: 'project-not-open' });
  if (project.workspaceProvider !== 'ssh' || !project.sshConnectionId) {
    return err({ type: 'not-ssh-project' });
  }
  try {
    const proxy = await sshConnectionManager.connect(project.sshConnectionId);
    const ctx = new SshExecutionContext(proxy);
    const ids = await getActiveSessionIds(ctx);
    return ok({ ids: Array.from(ids) });
  } catch (e) {
    return err({ type: 'ssh-unreachable', message: String(e) });
  }
}

function toRemoteSyncError(e: { type: string; message?: string }): RemoteSyncError {
  if (e.type === 'project-not-open') return { type: 'project-not-open' };
  if (e.type === 'not-ssh-project') return { type: 'not-ssh-project' };
  return { type: 'ssh-unreachable', message: e.message ?? 'unknown ssh error' };
}

export const remoteSyncController = createRPCController({
  triggerSync,
  getSyncStatus,
  getActiveSessionIds: getActiveSessionIdsForProject,
});
