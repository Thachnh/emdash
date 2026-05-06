import { cn } from '@renderer/utils/utils';

export function LiveAgentDot({ className }: { className?: string }) {
  return (
    <span
      className={cn('rounded-full bg-green-200 border size-2 border-green-500', className)}
      aria-label="Agent is running on remote"
      title="Agent is running on remote"
    />
  );
}
