import type { ClientId, ProjectKey } from '@shared/remote-sync';

export function syncRoot(home: string): string {
  return `${home.replace(/\/$/, '')}/.emdash/sync`;
}

export function projectDir(home: string, key: ProjectKey): string {
  return `${syncRoot(home)}/${key}`;
}

export function manifestPath(home: string, key: ProjectKey): string {
  return `${projectDir(home, key)}/manifest.json`;
}

export function manifestTmpPath(home: string, key: ProjectKey): string {
  return `${projectDir(home, key)}/manifest.json.tmp`;
}

export function clientsDir(home: string, key: ProjectKey): string {
  return `${projectDir(home, key)}/clients`;
}

export function snapshotPath(home: string, key: ProjectKey, clientId: ClientId): string {
  return `${clientsDir(home, key)}/${clientId}.json`;
}

export function snapshotTmpPath(home: string, key: ProjectKey, clientId: ClientId): string {
  return `${clientsDir(home, key)}/${clientId}.json.tmp`;
}
