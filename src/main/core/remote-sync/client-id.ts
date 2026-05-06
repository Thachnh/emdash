import { randomUUID } from 'node:crypto';
import { KV } from '@main/db/kv';
import type { ClientId } from '@shared/remote-sync';

type RemoteSyncKv = {
  clientId: ClientId;
};

const kv = new KV<RemoteSyncKv>('remote-sync');

let cached: ClientId | null = null;

export async function getClientId(): Promise<ClientId> {
  if (cached) return cached;
  const existing = await kv.get('clientId');
  if (existing) {
    cached = existing;
    return existing;
  }
  const fresh = randomUUID();
  await kv.set('clientId', fresh);
  cached = fresh;
  return fresh;
}
