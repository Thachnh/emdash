import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@main/db/client';
import { conversations, projects, tasks } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import {
  tasksRemovedFromSyncChannel,
  tasksUpsertedFromSyncChannel,
} from '@shared/events/taskEvents';
import type { TaskSyncRow } from './remote-sync-schema';
import type { MergedSnapshot } from './snapshot-merger';

export type ApplyResult = {
  inserted: number;
  updated: number;
  skipped: number;
  refused: number;
  deleted: number;
};

/**
 * Apply a merged snapshot into the local DB. UPSERT-by-id with
 * `remote.updatedAt > local.updatedAt` guard. Never deletes.
 */
export async function applyMergedToLocalDb(
  projectId: string,
  merged: MergedSnapshot
): Promise<ApplyResult> {
  const result: ApplyResult = { inserted: 0, updated: 0, skipped: 0, refused: 0, deleted: 0 };

  // Apply remote tombstones first: hard-delete any local task whose id appears
  // in another client's deletedTasks list. Conversations cascade via FK.
  if (merged.deletedTaskIds.size > 0) {
    const idsToDelete = Array.from(merged.deletedTaskIds);
    const localDeletable = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), inArray(tasks.id, idsToDelete)));
    if (localDeletable.length > 0) {
      const presentIds = localDeletable.map((r) => r.id);
      await db
        .delete(tasks)
        .where(and(eq(tasks.projectId, projectId), inArray(tasks.id, presentIds)));
      result.deleted += presentIds.length;
      events.emit(tasksRemovedFromSyncChannel, { projectId, taskIds: presentIds });
    }
  }

  if (merged.project && merged.project.id === projectId) {
    const [local] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (local) {
      if (local.workspaceProvider === 'ssh' && merged.project.updatedAt > local.updatedAt) {
        await db
          .update(projects)
          .set({
            name: merged.project.name,
            path: merged.project.path,
            baseRef: merged.project.baseRef,
            updatedAt: merged.project.updatedAt,
          })
          .where(eq(projects.id, projectId));
        result.updated += 1;
      } else {
        result.skipped += 1;
      }
    }
  }

  const taskIds = merged.tasks.map((t) => t.id);
  const localTasks =
    taskIds.length === 0 ? [] : await db.select().from(tasks).where(inArray(tasks.id, taskIds));
  const localTaskById = new Map(localTasks.map((t) => [t.id, t]));

  for (const remote of merged.tasks) {
    if (merged.deletedTaskIds.has(remote.id)) {
      result.skipped += 1;
      continue;
    }
    if (!isAcceptableWorkspaceProvider(remote.workspaceProvider)) {
      log.warn('remote-sync: refusing task with non-ssh workspaceProvider', {
        taskId: remote.id,
        workspaceProvider: remote.workspaceProvider,
      });
      result.refused += 1;
      continue;
    }

    const local = localTaskById.get(remote.id);
    if (!local) {
      await db.insert(tasks).values(toTaskInsert(projectId, remote));
      result.inserted += 1;
      continue;
    }
    if (remote.updatedAt > local.updatedAt) {
      await db
        .update(tasks)
        .set(toTaskUpdate(remote))
        .where(and(eq(tasks.id, remote.id), eq(tasks.projectId, projectId)));
      result.updated += 1;
    } else {
      result.skipped += 1;
    }
  }

  const conversationIds = merged.conversations.map((c) => c.id);
  const localConversations =
    conversationIds.length === 0
      ? []
      : await db.select().from(conversations).where(inArray(conversations.id, conversationIds));
  const localConvById = new Map(localConversations.map((c) => [c.id, c]));

  for (const remote of merged.conversations) {
    if (remote.projectId !== projectId) {
      result.refused += 1;
      continue;
    }
    const local = localConvById.get(remote.id);
    if (!local) {
      await db.insert(conversations).values({
        id: remote.id,
        projectId: remote.projectId,
        taskId: remote.taskId,
        title: remote.title,
        provider: remote.provider,
        config: remote.config,
        createdAt: remote.createdAt,
        updatedAt: remote.updatedAt,
      });
      result.inserted += 1;
      continue;
    }
    if (remote.updatedAt > local.updatedAt) {
      await db
        .update(conversations)
        .set({
          title: remote.title,
          provider: remote.provider,
          config: remote.config,
          updatedAt: remote.updatedAt,
        })
        .where(eq(conversations.id, remote.id));
      result.updated += 1;
    } else {
      result.skipped += 1;
    }
  }

  if (result.inserted + result.updated > 0) {
    events.emit(tasksUpsertedFromSyncChannel, { projectId });
  }

  return result;
}

function isAcceptableWorkspaceProvider(value: string | null): boolean {
  return value === null || value === 'ssh';
}

function toTaskInsert(projectId: string, row: TaskSyncRow) {
  return {
    id: row.id,
    projectId,
    name: row.name,
    status: row.status,
    sourceBranch: row.sourceBranch as never,
    taskBranch: row.taskBranch,
    linkedIssue: row.linkedIssue,
    archivedAt: row.archivedAt,
    isPinned: row.isPinned,
    workspaceProvider: row.workspaceProvider,
    workspaceId: row.workspaceId,
    lastInteractedAt: row.lastInteractedAt,
    statusChangedAt: row.statusChangedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toTaskUpdate(row: TaskSyncRow) {
  return {
    name: row.name,
    status: row.status,
    sourceBranch: row.sourceBranch as never,
    taskBranch: row.taskBranch,
    linkedIssue: row.linkedIssue,
    archivedAt: row.archivedAt,
    isPinned: row.isPinned,
    workspaceProvider: row.workspaceProvider,
    workspaceId: row.workspaceId,
    lastInteractedAt: row.lastInteractedAt,
    statusChangedAt: row.statusChangedAt,
    updatedAt: row.updatedAt,
  };
}
