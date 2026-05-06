import { createHash } from 'node:crypto';

export function normalizePosixPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

export function projectKey(host: string, user: string, path: string): string {
  const norm = `${user.toLowerCase()}@${host.toLowerCase()}:${normalizePosixPath(path)}`;
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}
