import { KV } from '@main/db/kv';

export type TaskTombstone = { id: string; deletedAt: string };

const kv = new KV<Record<string, TaskTombstone[]>>('remote-sync');

function key(projectId: string): string {
  return `tombstones:${projectId}`;
}

export async function recordTaskDeletion(projectId: string, taskId: string): Promise<void> {
  const existing = (await kv.get(key(projectId))) ?? [];
  if (existing.some((t) => t.id === taskId)) return;
  existing.push({ id: taskId, deletedAt: new Date().toISOString() });
  await kv.set(key(projectId), existing);
}

export async function getTaskTombstones(projectId: string): Promise<TaskTombstone[]> {
  return (await kv.get(key(projectId))) ?? [];
}
