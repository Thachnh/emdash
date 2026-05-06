export type ProjectKey = string;
export type ClientId = string;

export type RemoteSyncStatus = {
  projectId: string;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastError: string | null;
  inflight: 'idle' | 'pulling' | 'pushing';
};

export type RemoteSyncError =
  | { type: 'not-ssh-project' }
  | { type: 'project-not-open' }
  | { type: 'ssh-unreachable'; message: string }
  | { type: 'disabled' };
