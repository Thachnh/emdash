import { defineEvent } from '@shared/ipc/events';
import type { PullRequest } from '@shared/pull-requests';

export const taskStatusUpdatedChannel = defineEvent<{
  taskId: string;
  projectId: string;
  status: string;
}>('task:status-updated');

export const taskPrUpdatedChannel = defineEvent<{
  taskId: string;
  projectId: string;
  workspaceId: string;
  prs: PullRequest[];
}>('task:pr-updated');

export type ProvisionStep =
  | 'resolving-worktree'
  | 'initialising-workspace'
  | 'running-provision-script'
  | 'connecting'
  | 'setting-up-workspace'
  | 'starting-sessions';

export const taskProvisionProgressChannel = defineEvent<{
  taskId: string;
  projectId: string;
  step: ProvisionStep;
  message: string;
}>('task:provision-progress');

/**
 * Emitted when tasks have been inserted/updated by remote-sync. Tells the
 * renderer's TaskManagerStore to reload from the local DB so newly-synced
 * tasks appear in the UI without an emdash restart.
 */
export const tasksUpsertedFromSyncChannel = defineEvent<{
  projectId: string;
}>('task:upserted-from-sync');

/**
 * Emitted when remote-sync deletes tasks from the local DB (because another
 * client tombstoned them). The renderer's TaskManagerStore removes them from
 * its observable map.
 */
export const tasksRemovedFromSyncChannel = defineEvent<{
  projectId: string;
  taskIds: string[];
}>('task:removed-from-sync');
