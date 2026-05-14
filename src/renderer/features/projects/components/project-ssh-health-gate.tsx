import { type ReactNode } from 'react';

/**
 * Upstream introduced a "degraded SSH health" gate that replaces the entire
 * project view with a blocking panel on a single channel-open failure
 * (PR 352e42af). With this fork's additional background pollers
 * (remote-sync push/pull/tmux-poll, plus upstream's own git-remote polling)
 * a typical MaxSessions=10 server is saturated enough that the gate fires
 * continuously, making the app unusable. Disable the gate until we either
 * eliminate the channel pressure or replace this with a non-blocking
 * banner — errors still surface via the existing per-op toasts.
 */
export function ProjectSshHealthGate({ children }: { children: ReactNode; projectId: string }) {
  return <>{children}</>;
}
