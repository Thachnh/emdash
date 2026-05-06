import { TriangleAlert } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import { useRemoteSyncStatus } from './use-remote-sync-status';

export function RemoteSyncIndicator({ projectId }: { projectId: string }) {
  const status = useRemoteSyncStatus(projectId);
  if (!status) return null;

  if (status.lastError) {
    return (
      <Tooltip>
        <TooltipTrigger>
          <TriangleAlert className="h-3 w-3 shrink-0 text-foreground-destructive" />
        </TooltipTrigger>
        <TooltipContent>Remote sync error: {status.lastError}</TooltipContent>
      </Tooltip>
    );
  }

  if (status.inflight !== 'idle') {
    return (
      <span
        className={cn('rounded-full size-1.5 bg-foreground-passive opacity-60 animate-pulse')}
        aria-label="Remote sync in progress"
        title={status.inflight === 'pulling' ? 'Pulling remote state' : 'Pushing local state'}
      />
    );
  }

  return null;
}
