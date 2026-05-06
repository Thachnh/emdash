import { describe, expect, it } from 'vitest';
import { parseManifest, parseSnapshot, SCHEMA_VERSION } from './remote-sync-schema';

describe('parseSnapshot', () => {
  it('accepts a valid minimal snapshot', () => {
    const valid = {
      schemaVersion: SCHEMA_VERSION,
      clientId: 'client-1',
      projectKey: 'key1234',
      lastWriteAt: '2026-05-01T00:00:00.000Z',
      project: {
        id: 'p1',
        name: 'project',
        path: '/srv/repo',
        baseRef: null,
        workspaceProvider: 'ssh',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
      tasks: [],
      conversations: [],
    };
    const result = parseSnapshot(valid);
    expect(result.success).toBe(true);
  });

  it('rejects unknown schemaVersion', () => {
    const invalid = {
      schemaVersion: 99,
      clientId: 'client-1',
      projectKey: 'key',
      lastWriteAt: '2026-05-01T00:00:00.000Z',
      project: {
        id: 'p1',
        name: 'p',
        path: '/x',
        baseRef: null,
        workspaceProvider: 'ssh',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
      tasks: [],
      conversations: [],
    };
    const result = parseSnapshot(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects non-ssh workspaceProvider on the project row', () => {
    const invalid = {
      schemaVersion: SCHEMA_VERSION,
      clientId: 'client-1',
      projectKey: 'key',
      lastWriteAt: '2026-05-01T00:00:00.000Z',
      project: {
        id: 'p1',
        name: 'p',
        path: '/x',
        baseRef: null,
        workspaceProvider: 'local',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
      tasks: [],
      conversations: [],
    };
    const result = parseSnapshot(invalid);
    expect(result.success).toBe(false);
  });
});

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    const valid = {
      schemaVersion: SCHEMA_VERSION,
      canonicalProjectId: 'p1',
      projectKey: 'key',
      createdAt: '2026-05-01T00:00:00.000Z',
    };
    const result = parseManifest(valid);
    expect(result.success).toBe(true);
  });

  it('rejects missing canonicalProjectId', () => {
    const result = parseManifest({
      schemaVersion: SCHEMA_VERSION,
      projectKey: 'key',
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});
