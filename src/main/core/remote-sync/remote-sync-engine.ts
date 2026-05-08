import { hostname as osHostname } from 'node:os';
import { eq } from 'drizzle-orm';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import { resolveRemoteHome } from '@main/core/ssh/lifecycle/remote-shell-profile';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { db } from '@main/db/client';
import { projects, sshConnections } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { remoteSyncStatusChannel } from '@shared/events/remoteSyncEvents';
import type { ClientId, ProjectKey, RemoteSyncStatus } from '@shared/remote-sync';
import { err, ok, type Result } from '@shared/result';
import { getClientId } from './client-id';
import { projectKey } from './project-key';
import { SCHEMA_VERSION, type ClientSnapshot, type Manifest } from './remote-sync-schema';
import { RemoteSyncStore } from './remote-sync-store';
import { applyMergedToLocalDb } from './snapshot-applier';
import { buildLocalSnapshot } from './snapshot-builder';
import { mergeSnapshots, type MergedSnapshot } from './snapshot-merger';
import { getTaskTombstones } from './tombstones';

export type AdoptArgs = {
  proxy: SshClientProxy;
  ctx: SshExecutionContext;
  remoteHome: string;
  projectKey: ProjectKey;
  candidateId: string;
};

export type AdoptResult = {
  canonicalProjectId: string;
  isFirstClient: boolean;
  merged?: MergedSnapshot;
};

export type EngineError =
  | { type: 'project-not-open' }
  | { type: 'not-ssh-project' }
  | { type: 'ssh-unreachable'; message: string };

type EngineState = {
  projectId: string;
  key: ProjectKey;
  home: string;
  clientId: ClientId;
  store: RemoteSyncStore;
  status: RemoteSyncStatus;
  inflight: 'idle' | 'pulling' | 'pushing';
  pushPending: boolean;
  pushDebounce?: ReturnType<typeof setTimeout>;
  pushPromise?: Promise<void>;
};

const PUSH_DEBOUNCE_MS = 750;

export class RemoteSyncEngine {
  private readonly _states = new Map<string, EngineState>();

  /**
   * Decide the canonical projectId before the local DB row is inserted.
   * If a manifest already exists on the remote, adopt its `canonicalProjectId`
   * and pre-fetch all client snapshots so the caller can reconcile right after
   * the local insert. If no manifest exists, claim it with our `candidateId`.
   */
  async adopt(args: AdoptArgs): Promise<AdoptResult> {
    const clientId = await getClientId();
    const store = new RemoteSyncStore(args.proxy, args.ctx, args.remoteHome, args.projectKey);
    await store.ensureDirs();

    const existing = await store.readManifest();
    if (existing) {
      const merged = await this._readAndMerge(store, clientId);
      return { canonicalProjectId: existing.canonicalProjectId, isFirstClient: false, merged };
    }

    const candidate: Manifest = {
      schemaVersion: SCHEMA_VERSION,
      canonicalProjectId: args.candidateId,
      projectKey: args.projectKey,
      createdAt: new Date().toISOString(),
    };
    const claim = await store.claimManifest(candidate);
    if (claim.kind === 'won') {
      return { canonicalProjectId: claim.manifest.canonicalProjectId, isFirstClient: true };
    }
    const merged = await this._readAndMerge(store, clientId);
    return {
      canonicalProjectId: claim.manifest.canonicalProjectId,
      isFirstClient: false,
      merged,
    };
  }

  /**
   * Build engine state for a freshly-opened SSH project. Idempotent.
   */
  async activate(projectId: string): Promise<Result<void, EngineError>> {
    if (this._states.has(projectId)) return ok();

    const stateResult = await this._buildState(projectId);
    if (!stateResult.success) return stateResult;
    this._states.set(projectId, stateResult.data);
    return ok();
  }

  deactivate(projectId: string): void {
    const state = this._states.get(projectId);
    if (!state) return;
    if (state.pushDebounce) clearTimeout(state.pushDebounce);
    this._states.delete(projectId);
  }

  /** Write our snapshot now (used at bootstrap right after local insert). */
  async bootstrap(projectId: string): Promise<Result<void, EngineError>> {
    const state = this._states.get(projectId);
    if (!state) {
      const built = await this._buildState(projectId);
      if (!built.success) return built;
      this._states.set(projectId, built.data);
    }
    return this.push(projectId, { immediate: true });
  }

  async pull(projectId: string): Promise<Result<void, EngineError>> {
    const state = this._states.get(projectId);
    if (!state) return err({ type: 'project-not-open' });
    state.inflight = 'pulling';
    state.status.inflight = 'pulling';
    try {
      const merged = await this._readAndMerge(state.store, state.clientId);
      await this._applyLocalTombstones(projectId, merged);
      await applyMergedToLocalDb(projectId, merged);
      state.status.lastPullAt = new Date().toISOString();
      state.status.lastError = null;
    } catch (e) {
      state.status.lastError = String(e);
      log.warn('remote-sync: pull failed', { projectId, error: String(e) });
      this._emitStatus(state);
      state.inflight = 'idle';
      state.status.inflight = 'idle';
      return err({ type: 'ssh-unreachable', message: String(e) });
    }
    state.inflight = 'idle';
    state.status.inflight = 'idle';
    this._emitStatus(state);
    return ok();
  }

  async push(
    projectId: string,
    opts: { immediate?: boolean } = {}
  ): Promise<Result<void, EngineError>> {
    const state = this._states.get(projectId);
    if (!state) return err({ type: 'project-not-open' });

    if (!opts.immediate) {
      this.schedulePush(projectId);
      return ok();
    }
    return this._doPush(state);
  }

  schedulePush(projectId: string): void {
    const state = this._states.get(projectId);
    if (!state) return;
    if (state.pushDebounce) clearTimeout(state.pushDebounce);
    state.pushDebounce = setTimeout(() => {
      state.pushDebounce = undefined;
      void this._doPush(state);
    }, PUSH_DEBOUNCE_MS);
  }

  getStatus(projectId: string): RemoteSyncStatus | null {
    const state = this._states.get(projectId);
    return state ? { ...state.status } : null;
  }

  getStore(projectId: string): RemoteSyncStore | null {
    return this._states.get(projectId)?.store ?? null;
  }

  isActive(projectId: string): boolean {
    return this._states.has(projectId);
  }

  private async _doPush(state: EngineState): Promise<Result<void, EngineError>> {
    if (state.pushPromise) {
      state.pushPending = true;
      return ok();
    }
    state.inflight = 'pushing';
    state.status.inflight = 'pushing';

    state.pushPromise = (async () => {
      try {
        const snapshot = await buildLocalSnapshot({
          projectId: state.projectId,
          projectKey: state.key,
          clientId: state.clientId,
          hostname: osHostname(),
        });
        if (!snapshot) {
          log.warn('remote-sync: snapshot build returned null', { projectId: state.projectId });
          return;
        }
        await state.store.writeOwnSnapshot(snapshot);
        state.status.lastPushAt = new Date().toISOString();
        state.status.lastError = null;
      } catch (e) {
        state.status.lastError = String(e);
        log.warn('remote-sync: push failed', { projectId: state.projectId, error: String(e) });
      } finally {
        state.inflight = 'idle';
        state.status.inflight = 'idle';
        this._emitStatus(state);
      }
    })();

    try {
      await state.pushPromise;
    } finally {
      state.pushPromise = undefined;
      if (state.pushPending) {
        state.pushPending = false;
        // Fire-and-forget the trailing push.
        void this._doPush(state);
      }
    }
    return ok();
  }

  private async _readAndMerge(
    store: RemoteSyncStore,
    ourClientId: ClientId
  ): Promise<MergedSnapshot> {
    const ids = await store.listClientSnapshotIds();
    const snapshots: ClientSnapshot[] = [];
    for (const id of ids) {
      if (id === ourClientId) continue;
      const snap = await store.readSnapshot(id);
      if (snap) snapshots.push(snap);
    }
    return mergeSnapshots(snapshots);
  }

  /**
   * Union our local tombstones into the merged result before applying.
   * Without this, a delete on this client would not stop other clients'
   * (still-stale) snapshots from re-inserting the task on our next pull —
   * the merge skips our own snapshot, so our tombstones never reach the
   * filter step. Re-filters merged.tasks since deletedTaskIds is widened.
   */
  private async _applyLocalTombstones(projectId: string, merged: MergedSnapshot): Promise<void> {
    const local = await getTaskTombstones(projectId);
    if (local.length === 0) return;
    for (const t of local) merged.deletedTaskIds.add(t.id);
    merged.tasks = merged.tasks.filter((t) => !merged.deletedTaskIds.has(t.id));
  }

  private async _buildState(projectId: string): Promise<Result<EngineState, EngineError>> {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return err({ type: 'project-not-open' });
    if (project.workspaceProvider !== 'ssh' || !project.sshConnectionId) {
      return err({ type: 'not-ssh-project' });
    }
    const [conn] = await db
      .select()
      .from(sshConnections)
      .where(eq(sshConnections.id, project.sshConnectionId));
    if (!conn) return err({ type: 'not-ssh-project' });

    let step: 'connect' | 'home' | 'clientId' | 'ensureDirs' | 'ensureManifest' = 'connect';
    try {
      const proxy = await sshConnectionManager.connect(project.sshConnectionId);
      step = 'home';
      const ctx = new SshExecutionContext(proxy);
      const home = await resolveRemoteHome(ctx);
      const key = projectKey(conn.host, conn.username, project.path);
      step = 'clientId';
      const clientId = await getClientId();
      const store = new RemoteSyncStore(proxy, ctx, home, key);
      step = 'ensureDirs';
      await store.ensureDirs();
      // Pre-existing projects (added before remote-sync shipped) skipped the
      // manifest-claim step in `tryAdoptRemoteSync`. Lazy-claim it here so the
      // manifest always reflects this project's canonicalProjectId by the time
      // any other client adopts it.
      step = 'ensureManifest';
      await this._ensureManifest(store, key, projectId);

      const status: RemoteSyncStatus = {
        projectId,
        lastPullAt: null,
        lastPushAt: null,
        lastError: null,
        inflight: 'idle',
      };

      return ok({
        projectId,
        key,
        home,
        clientId,
        store,
        status,
        inflight: 'idle',
        pushPending: false,
      });
    } catch (e) {
      log.warn('remote-sync: failed to build engine state', {
        projectId,
        step,
        error: String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      return err({ type: 'ssh-unreachable', message: `${step}: ${String(e)}` });
    }
  }

  private async _ensureManifest(
    store: RemoteSyncStore,
    key: ProjectKey,
    projectId: string
  ): Promise<void> {
    try {
      const existing = await store.readManifest();
      if (existing) {
        if (existing.canonicalProjectId !== projectId) {
          log.warn(
            'remote-sync: local projectId differs from canonical manifest; clients will not converge until reconciled',
            {
              projectId,
              canonicalProjectId: existing.canonicalProjectId,
              key,
            }
          );
        }
        return;
      }
      const candidate: Manifest = {
        schemaVersion: SCHEMA_VERSION,
        canonicalProjectId: projectId,
        projectKey: key,
        createdAt: new Date().toISOString(),
      };
      await store.claimManifest(candidate);
    } catch (e) {
      log.warn('remote-sync: ensure manifest failed', { projectId, error: String(e) });
    }
  }

  private _emitStatus(state: EngineState): void {
    events.emit(remoteSyncStatusChannel, { ...state.status });
  }
}

export const remoteSyncEngine = new RemoteSyncEngine();
