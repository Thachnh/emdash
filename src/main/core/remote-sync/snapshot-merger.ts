import type {
  ClientSnapshot,
  ConversationSyncRow,
  ProjectSyncRow,
  TaskSyncRow,
} from './remote-sync-schema';

export type MergedSnapshot = {
  project: ProjectSyncRow | null;
  tasks: TaskSyncRow[];
  conversations: ConversationSyncRow[];
  /** Set of task ids that any client has marked as deleted. Deletions win. */
  deletedTaskIds: Set<string>;
};

/**
 * LWW merge: pick the row version with the greatest `updatedAt` (ISO-8601
 * lexicographic compare). Tiebreak: lexicographic clientId.
 */
export function mergeSnapshots(snapshots: ClientSnapshot[]): MergedSnapshot {
  const projectByLatest = pickLatest(
    snapshots.map((s) => ({ row: s.project, updatedAt: s.project.updatedAt, clientId: s.clientId }))
  );

  const deletedTaskIds = new Set<string>();
  for (const s of snapshots) {
    for (const t of s.deletedTasks ?? []) deletedTaskIds.add(t.id);
  }

  const tasks = mergeRows(
    snapshots.flatMap((s) => s.tasks.map((row) => ({ row, clientId: s.clientId })))
  ).filter((t) => !deletedTaskIds.has(t.id));

  const conversations = mergeRows(
    snapshots.flatMap((s) => s.conversations.map((row) => ({ row, clientId: s.clientId })))
  );

  return {
    project: projectByLatest?.row ?? null,
    tasks,
    conversations,
    deletedTaskIds,
  };
}

function mergeRows<T extends { id: string; updatedAt: string }>(
  entries: Array<{ row: T; clientId: string }>
): T[] {
  const byId = new Map<string, { row: T; clientId: string }>();
  for (const entry of entries) {
    const existing = byId.get(entry.row.id);
    if (!existing || isNewer(entry, existing)) {
      byId.set(entry.row.id, entry);
    }
  }
  return Array.from(byId.values()).map((e) => e.row);
}

function isNewer<T extends { updatedAt: string }>(
  a: { row: T; clientId: string },
  b: { row: T; clientId: string }
): boolean {
  if (a.row.updatedAt > b.row.updatedAt) return true;
  if (a.row.updatedAt < b.row.updatedAt) return false;
  return a.clientId > b.clientId;
}

function pickLatest<T>(
  entries: Array<{ row: T; updatedAt: string; clientId: string }>
): { row: T; updatedAt: string; clientId: string } | undefined {
  let best: { row: T; updatedAt: string; clientId: string } | undefined;
  for (const entry of entries) {
    if (!best || entry.updatedAt > best.updatedAt) {
      best = entry;
      continue;
    }
    if (entry.updatedAt === best.updatedAt && entry.clientId > best.clientId) {
      best = entry;
    }
  }
  return best;
}
