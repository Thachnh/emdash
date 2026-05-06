import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { ProjectPathStatus, SshProject } from '@shared/projects';
import { GitHubAuthExecutionContext } from '@main/core/execution-context/github-auth-execution-context';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { GitService } from '@main/core/git/impl/git-service';
import { githubConnectionService } from '@main/core/github/services/github-connection-service';
import { projectEvents } from '@main/core/projects/project-events';
import { projectManager } from '@main/core/projects/project-manager';
import { projectKey } from '@main/core/remote-sync/project-key';
import { remoteSyncEngine } from '@main/core/remote-sync/remote-sync-engine';
import { applyMergedToLocalDb } from '@main/core/remote-sync/snapshot-applier';
import type { MergedSnapshot } from '@main/core/remote-sync/snapshot-merger';
import type { SshClientProxy } from '@main/core/ssh/ssh-client-proxy';
import { sshConnectionManager } from '@main/core/ssh/ssh-connection-manager';
import { resolveRemoteHome } from '@main/core/ssh/utils';
import { db } from '@main/db/client';
import { projects, sshConnections } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { ensureGitRepository, resolveProjectBaseRef } from './create-project-utils';

export type CreateSshProjectParams = {
  id?: string;
  name: string;
  path: string;
  connectionId: string;
  initGitRepository?: boolean;
};

export async function createSshProject(params: CreateSshProjectParams): Promise<SshProject> {
  const sshProxy = await sshConnectionManager.connect(params.connectionId);

  const sshFs = new SshFileSystem(sshProxy, params.path);
  const pathEntry = await sshFs.stat('');
  if (!pathEntry || pathEntry.type !== 'dir') {
    throw new Error('Invalid directory');
  }
  const baseSshCtx = new SshExecutionContext(sshProxy, { root: params.path });
  const authSshCtx = new GitHubAuthExecutionContext(baseSshCtx, () =>
    githubConnectionService.getToken()
  );
  const git = new GitService(baseSshCtx, authSshCtx, sshFs);

  const gitInfo = await ensureGitRepository(git, params.initGitRepository);
  const baseRef = await resolveProjectBaseRef(git, gitInfo.baseRef);

  const candidateId = params.id ?? randomUUID();
  const adoption = await tryAdoptRemoteSync({
    proxy: sshProxy,
    ctx: baseSshCtx,
    connectionId: params.connectionId,
    canonicalPath: gitInfo.rootPath,
    candidateId,
  });

  const [row] = await db
    .insert(projects)
    .values({
      id: adoption.canonicalProjectId,
      name: params.name,
      path: gitInfo.rootPath,
      workspaceProvider: 'ssh',
      sshConnectionId: params.connectionId,
      baseRef,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .returning();

  if (adoption.merged) {
    try {
      await applyMergedToLocalDb(row.id, adoption.merged);
    } catch (e) {
      log.warn('remote-sync: failed to apply prefetched snapshots', {
        projectId: row.id,
        error: String(e),
      });
    }
  }

  const project = {
    type: 'ssh' as const,
    id: row.id,
    name: row.name,
    path: row.path,
    connectionId: params.connectionId,
    baseRef: row.baseRef ?? baseRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  await projectManager.openProject(project);
  projectEvents._emit('project:created', project);

  if (adoption.attempted) {
    void remoteSyncEngine.bootstrap(row.id).catch((e) => {
      log.warn('remote-sync: bootstrap failed', { projectId: row.id, error: String(e) });
    });
  }

  return project;
}

async function tryAdoptRemoteSync(args: {
  proxy: SshClientProxy;
  ctx: SshExecutionContext;
  connectionId: string;
  canonicalPath: string;
  candidateId: string;
}): Promise<{
  canonicalProjectId: string;
  merged?: MergedSnapshot;
  attempted: boolean;
}> {
  if (process.env.EMDASH_DISABLE_REMOTE_SYNC === '1') {
    return { canonicalProjectId: args.candidateId, attempted: false };
  }
  try {
    const [conn] = await db
      .select()
      .from(sshConnections)
      .where(eq(sshConnections.id, args.connectionId));
    if (!conn) return { canonicalProjectId: args.candidateId, attempted: false };
    const home = await resolveRemoteHome(args.ctx);
    const key = projectKey(conn.host, conn.username, args.canonicalPath);
    const result = await remoteSyncEngine.adopt({
      proxy: args.proxy,
      ctx: args.ctx,
      remoteHome: home,
      projectKey: key,
      candidateId: args.candidateId,
    });
    return {
      canonicalProjectId: result.canonicalProjectId,
      merged: result.merged,
      attempted: true,
    };
  } catch (e) {
    log.warn('remote-sync: adopt failed, proceeding with local UUID', {
      candidateId: args.candidateId,
      error: String(e),
    });
    return { canonicalProjectId: args.candidateId, attempted: false };
  }
}

export async function getSshProjectPathStatus(
  path: string,
  connectionId: string
): Promise<ProjectPathStatus> {
  try {
    const sshProxy = await sshConnectionManager.connect(connectionId);
    const sshFs = new SshFileSystem(sshProxy, path);
    const pathEntry = await sshFs.stat('');
    if (!pathEntry || pathEntry.type !== 'dir') {
      return { isDirectory: false, isGitRepo: false };
    }

    const baseSshCtx = new SshExecutionContext(sshProxy, { root: path });
    const authSshCtx = new GitHubAuthExecutionContext(baseSshCtx, () =>
      githubConnectionService.getToken()
    );
    const git = new GitService(baseSshCtx, authSshCtx, sshFs);
    const gitInfo = await git.detectInfo();
    return { isDirectory: true, isGitRepo: gitInfo.isGitRepo };
  } catch {
    return { isDirectory: false, isGitRepo: false };
  }
}
