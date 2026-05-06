import { z } from 'zod';
import { err, ok, type Result } from '@shared/result';

export const SCHEMA_VERSION = 1;

const projectSyncRow = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  baseRef: z.string().nullable(),
  workspaceProvider: z.literal('ssh'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const taskSyncRow = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  sourceBranch: z.unknown().nullable(),
  taskBranch: z.string().nullable(),
  linkedIssue: z.string().nullable(),
  archivedAt: z.string().nullable(),
  isPinned: z.union([z.literal(0), z.literal(1)]),
  workspaceProvider: z.string().nullable(),
  workspaceId: z.string().nullable(),
  lastInteractedAt: z.string().nullable(),
  statusChangedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const conversationSyncRow = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  title: z.string(),
  provider: z.string().nullable(),
  config: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const taskTombstoneRow = z.object({
  id: z.string(),
  deletedAt: z.string(),
});

export const clientSnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  clientId: z.string(),
  projectKey: z.string(),
  lastWriteAt: z.string(),
  hostname: z.string().optional(),
  project: projectSyncRow,
  tasks: z.array(taskSyncRow),
  conversations: z.array(conversationSyncRow),
  // Optional for backwards compat with snapshots written before tombstones
  // were introduced. Treat missing as empty.
  deletedTasks: z.array(taskTombstoneRow).optional().default([]),
});

export const manifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  canonicalProjectId: z.string(),
  projectKey: z.string(),
  createdAt: z.string(),
});

export type ClientSnapshot = z.infer<typeof clientSnapshotSchema>;
export type ProjectSyncRow = z.infer<typeof projectSyncRow>;
export type TaskSyncRow = z.infer<typeof taskSyncRow>;
export type ConversationSyncRow = z.infer<typeof conversationSyncRow>;
export type TaskTombstoneRow = z.infer<typeof taskTombstoneRow>;
export type Manifest = z.infer<typeof manifestSchema>;

export type SnapshotParseError = { type: 'parse'; message: string };

export function parseSnapshot(raw: unknown): Result<ClientSnapshot, SnapshotParseError> {
  const parsed = clientSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return err({ type: 'parse', message: parsed.error.message });
  }
  return ok(parsed.data);
}

export function parseManifest(raw: unknown): Result<Manifest, SnapshotParseError> {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return err({ type: 'parse', message: parsed.error.message });
  }
  return ok(parsed.data);
}
