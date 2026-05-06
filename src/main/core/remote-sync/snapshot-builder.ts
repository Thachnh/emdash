import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { conversations, projects, tasks } from '@main/db/schema';
import type { ClientId, ProjectKey } from '@shared/remote-sync';
import { SCHEMA_VERSION, type ClientSnapshot } from './remote-sync-schema';
import { getTaskTombstones } from './tombstones';

export async function buildLocalSnapshot(args: {
  projectId: string;
  projectKey: ProjectKey;
  clientId: ClientId;
  hostname?: string;
}): Promise<ClientSnapshot | null> {
  const [project] = await db.select().from(projects).where(eq(projects.id, args.projectId));
  if (!project) return null;
  if (project.workspaceProvider !== 'ssh') return null;

  const taskRows = await db.select().from(tasks).where(eq(tasks.projectId, args.projectId));
  const conversationRows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.projectId, args.projectId));
  const tombstones = await getTaskTombstones(args.projectId);

  return {
    schemaVersion: SCHEMA_VERSION,
    clientId: args.clientId,
    projectKey: args.projectKey,
    lastWriteAt: new Date().toISOString(),
    hostname: args.hostname,
    project: {
      id: project.id,
      name: project.name,
      path: project.path,
      baseRef: project.baseRef ?? null,
      workspaceProvider: 'ssh',
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    tasks: taskRows.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      sourceBranch: t.sourceBranch ?? null,
      taskBranch: t.taskBranch ?? null,
      linkedIssue: t.linkedIssue ?? null,
      archivedAt: t.archivedAt ?? null,
      isPinned: (t.isPinned ? 1 : 0) as 0 | 1,
      workspaceProvider: t.workspaceProvider ?? null,
      workspaceId: t.workspaceId ?? null,
      lastInteractedAt: t.lastInteractedAt ?? null,
      statusChangedAt: t.statusChangedAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    conversations: conversationRows.map((c) => ({
      id: c.id,
      projectId: c.projectId,
      taskId: c.taskId,
      title: c.title,
      provider: c.provider ?? null,
      config: c.config ?? null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
    deletedTasks: tombstones,
  };
}
