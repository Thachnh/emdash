import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { remoteSyncStatusChannel } from '@shared/events/remoteSyncEvents';
import type { RemoteSyncStatus } from '@shared/remote-sync';

const queryKey = (projectId: string) => ['remote-sync', 'status', projectId] as const;

export function useRemoteSyncStatus(projectId: string): RemoteSyncStatus | null {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: queryKey(projectId),
    queryFn: () => rpc.remoteSync.getSyncStatus(projectId),
    staleTime: Infinity,
  });

  useEffect(() => {
    return events.on(remoteSyncStatusChannel, (status) => {
      if (status.projectId !== projectId) return;
      queryClient.setQueryData<RemoteSyncStatus>(queryKey(projectId), status);
    });
  }, [projectId, queryClient]);

  return data ?? null;
}
