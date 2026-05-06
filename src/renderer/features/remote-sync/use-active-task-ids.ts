import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { remoteSyncActiveSessionsChannel } from '@shared/events/remoteSyncEvents';
import { events, rpc } from '@renderer/lib/ipc';

const queryKey = (projectId: string) => ['remote-sync', 'active', projectId] as const;

function sessionIdsToTaskIds(sessionIds: readonly string[]): Set<string> {
  const taskIds = new Set<string>();
  for (const sid of sessionIds) {
    const parts = sid.split(':');
    if (parts.length !== 3) continue;
    const taskId = parts[1];
    if (taskId) taskIds.add(taskId);
  }
  return taskIds;
}

export function useActiveTaskIds(projectId: string): Set<string> {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: queryKey(projectId),
    queryFn: async (): Promise<string[]> => {
      const res = await rpc.remoteSync.getActiveSessionIds(projectId);
      return res.success ? res.data.ids : [];
    },
    staleTime: 60_000,
  });

  useEffect(() => {
    return events.on(remoteSyncActiveSessionsChannel, (payload) => {
      if (payload.projectId !== projectId) return;
      queryClient.setQueryData<string[]>(queryKey(projectId), payload.activeSessionIds);
    });
  }, [projectId, queryClient]);

  return useMemo(() => sessionIdsToTaskIds(data ?? []), [data]);
}
