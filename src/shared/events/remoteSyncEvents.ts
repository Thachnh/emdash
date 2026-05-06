import { defineEvent } from '@shared/ipc/events';
import type { RemoteSyncStatus } from '@shared/remote-sync';

export const remoteSyncStatusChannel = defineEvent<RemoteSyncStatus>('remote-sync:status');

export const remoteSyncActiveSessionsChannel = defineEvent<{
  projectId: string;
  activeSessionIds: string[];
}>('remote-sync:active-sessions');
