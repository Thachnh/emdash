import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ClientSnapshot } from './remote-sync-schema';
import { mergeSnapshots } from './snapshot-merger';

function makeSnapshot(overrides: {
  clientId: string;
  tasks?: ClientSnapshot['tasks'];
  conversations?: ClientSnapshot['conversations'];
  project?: Partial<ClientSnapshot['project']>;
  deletedTasks?: ClientSnapshot['deletedTasks'];
}): ClientSnapshot {
  const baseProject: ClientSnapshot['project'] = {
    id: 'p1',
    name: 'project',
    path: '/srv/repo',
    baseRef: 'main',
    workspaceProvider: 'ssh',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides.project,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    clientId: overrides.clientId,
    projectKey: 'key1234',
    lastWriteAt: '2026-05-01T00:00:00.000Z',
    project: baseProject,
    tasks: overrides.tasks ?? [],
    conversations: overrides.conversations ?? [],
    deletedTasks: overrides.deletedTasks ?? [],
  };
}

function makeTask(
  overrides: Partial<ClientSnapshot['tasks'][number]>
): ClientSnapshot['tasks'][number] {
  return {
    id: 't1',
    name: 'task',
    status: 'queued',
    sourceBranch: null,
    taskBranch: null,
    linkedIssue: null,
    archivedAt: null,
    isPinned: 0,
    workspaceProvider: 'ssh',
    workspaceId: null,
    lastInteractedAt: null,
    statusChangedAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('mergeSnapshots', () => {
  it('returns empty merged for empty input', () => {
    const merged = mergeSnapshots([]);
    expect(merged.project).toBeNull();
    expect(merged.tasks).toEqual([]);
    expect(merged.conversations).toEqual([]);
    expect(merged.deletedTaskIds.size).toBe(0);
  });

  it('drops tombstoned tasks and surfaces their ids in deletedTaskIds', () => {
    const sA = makeSnapshot({
      clientId: 'A',
      tasks: [makeTask({ id: 't1' }), makeTask({ id: 't2' })],
    });
    const sB = makeSnapshot({
      clientId: 'B',
      tasks: [makeTask({ id: 't1' })], // B still has t1 in its tasks list
      deletedTasks: [{ id: 't1', deletedAt: '2026-05-02T00:00:00.000Z' }],
    });
    const merged = mergeSnapshots([sA, sB]);
    expect(merged.tasks.map((t) => t.id).sort()).toEqual(['t2']);
    expect(Array.from(merged.deletedTaskIds)).toEqual(['t1']);
  });

  it('keeps the task version with the latest updatedAt across snapshots', () => {
    const sA = makeSnapshot({
      clientId: 'A',
      tasks: [makeTask({ id: 't1', name: 'original', updatedAt: '2026-05-01T00:00:00.000Z' })],
    });
    const sB = makeSnapshot({
      clientId: 'B',
      tasks: [makeTask({ id: 't1', name: 'renamed', updatedAt: '2026-05-01T01:00:00.000Z' })],
    });
    const sC = makeSnapshot({
      clientId: 'C',
      tasks: [
        makeTask({
          id: 't1',
          name: 'renamed',
          archivedAt: '2026-05-01T02:00:00.000Z',
          updatedAt: '2026-05-01T02:00:00.000Z',
        }),
      ],
    });
    const merged = mergeSnapshots([sA, sB, sC]);
    expect(merged.tasks).toHaveLength(1);
    expect(merged.tasks[0].name).toBe('renamed');
    expect(merged.tasks[0].archivedAt).toBe('2026-05-01T02:00:00.000Z');
  });

  it('breaks ties by clientId (lexicographically greater wins)', () => {
    const sA = makeSnapshot({
      clientId: 'A',
      tasks: [makeTask({ id: 't1', name: 'A-version', updatedAt: '2026-05-01T00:00:00.000Z' })],
    });
    const sB = makeSnapshot({
      clientId: 'B',
      tasks: [makeTask({ id: 't1', name: 'B-version', updatedAt: '2026-05-01T00:00:00.000Z' })],
    });
    const merged = mergeSnapshots([sA, sB]);
    expect(merged.tasks[0].name).toBe('B-version');
  });

  it('returns the project row from the snapshot with the latest project updatedAt', () => {
    const sA = makeSnapshot({
      clientId: 'A',
      project: { name: 'old-name', updatedAt: '2026-05-01T00:00:00.000Z' },
    });
    const sB = makeSnapshot({
      clientId: 'B',
      project: { name: 'new-name', updatedAt: '2026-05-02T00:00:00.000Z' },
    });
    const merged = mergeSnapshots([sA, sB]);
    expect(merged.project?.name).toBe('new-name');
  });

  it('unions tasks across snapshots when ids are distinct', () => {
    const sA = makeSnapshot({
      clientId: 'A',
      tasks: [makeTask({ id: 't1' })],
    });
    const sB = makeSnapshot({
      clientId: 'B',
      tasks: [makeTask({ id: 't2' })],
    });
    const merged = mergeSnapshots([sA, sB]);
    expect(merged.tasks.map((t) => t.id).sort()).toEqual(['t1', 't2']);
  });
});
