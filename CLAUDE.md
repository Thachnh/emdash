# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

emdash is an Electron desktop app that orchestrates parallel coding agents (Claude Code, Codex, OpenCode, Gemini, etc.) in isolated git worktrees, either locally or over SSH on a remote machine.

## Canonical guide

`AGENTS.md` is the source of truth. It carries the frontmatter (commands, env vars), the per-task links into `agents/` (architecture, conventions, risky areas, workflows), and the project's non-negotiables. Read it before non-trivial work; **load only the linked `agents/*.md` files relevant to the task** rather than scanning the tree.

## Commands

```bash
pnpm run d              # pnpm install + electron-vite dev
pnpm run dev            # electron-vite dev
pnpm run dev:main       # restart only on main-process changes
pnpm run dev:renderer   # restart only on renderer changes
pnpm run build          # electron-vite build
pnpm run package:mac    # release/ → dmg/zip
pnpm run package:linux  # release/ → AppImage/deb/rpm
pnpm run rebuild        # re-link better-sqlite3 / node-pty against installed Electron ABI

# pre-merge gate (run all four before merging)
pnpm run format && pnpm run lint && pnpm run typecheck && pnpm run test

# single test file or by name
pnpm vitest run <path>
pnpm vitest run -t "<name pattern>"

# DB
pnpm run db:generate    # generate Drizzle migration after schema.ts edits
pnpm run db:reset       # delete the local emdash db (dev only)
```

`scripts/postinstall.ts` rebuilds native modules (`better-sqlite3`, `node-pty`, `@parcel/watcher`) against the installed Electron ABI on every install. If you see `NODE_MODULE_VERSION` mismatches after a Node-version switch, run `pnpm run rebuild`.

## Architecture in two minutes

- **Two processes.** `src/main/` is Node/Electron main (DB, SSH, PTY, services, RPC). `src/renderer/` is React + MobX + React Query + Vite. They speak through a typed RPC router (`src/main/rpc.ts`) and topic-based events (`src/shared/ipc/events.ts`, channels in `src/shared/events/`).
- **Local vs SSH duality.** Most main-process domains have parallel local and SSH implementations behind a shared interface — `LocalFileSystem`/`SshFileSystem`, `LocalExecutionContext`/`SshExecutionContext`, local- vs SSH- conversation/terminal providers. Branch on `project.workspaceProvider === 'ssh'`.
- **Deterministic PTY session IDs.** `makePtySessionId(projectId, scopeId, leafId)` in `src/shared/ptySessionId.ts` returns `"<projectId>:<scopeId>:<leafId>"`. The tmux session name is `emdash-<base64url(sessionId)>`. This lets the renderer subscribe to the PTY data channel before a session has actually started, and lets multiple emdash clients reattach to the same live tmux session on a shared SSH server.
- **DB.** SQLite via `better-sqlite3` + Drizzle. Schema in `src/main/db/schema.ts`; migrations in `drizzle/` (don't hand-edit). Typed namespaced settings via `src/main/db/kv.ts` (`new KV<...>('namespace')`).
- **Lifecycle.** `projectManager` emits `projectOpened`/`projectClosed`; `taskManager.hooks` emits `task:provisioned`/`task:torn-down`. New background services implement `IInitializable`/`IDisposable`, register in `src/main/index.ts`, and subscribe to those hooks. `pr-sync-scheduler.ts` is the canonical template.
- **Remote sync** (`src/main/core/remote-sync/`). When two emdash clients open the same SSH project, they share project/task/conversation metadata via per-client JSON snapshots at `~/.emdash/sync/<projectKey>/clients/<clientId>.json` on the remote, merged last-write-wins per row. A `manifest.json` claim decides the canonical projectId. Deletions propagate via per-project tombstones in `kv`. Disable with `EMDASH_DISABLE_REMOTE_SYNC=1`. See **Remote-sync patch** below for the full design.

## Remote-sync patch (this fork)

This fork carries a remote-sync feature that does not exist upstream. State of the work:

- Branch: `feat/remote-sync` on `Thachnh/emdash` (origin). `upstream` remote points at `generalaction/emdash`.
- Two-commit layout on top of `main`:
  1. `feat(remote-sync): sync task list across emdash clients on SSH-remote projects` — the actual feature, ~31 files, intended to be PR-able to upstream.
  2. `chore: pin version to 99.0.0-thach to disable auto-updater` — local-only; **drop this commit before opening an upstream PR** or `electron-updater` will replace the fork build with the official release on launch.

**What problem it solves.** Each emdash install has its own local SQLite DB, so two machines pointing at the same SSH-remote project would diverge: tasks created on one were invisible on the other, archiving one didn't reflect on the other, and even though the agent itself runs in a tmux session on the remote, the second machine couldn't auto-reattach because each client minted its own UUIDs.

**Key design choices.**

- **Per-client snapshots, merged on read.** Each client owns one `<clientId>.json` file. No write contention; LWW per row by `updatedAt`, ISO-8601 lexicographic compare, tiebreak on `clientId`.
- **Storage path.** Out-of-tree at `~/.emdash/sync/<projectKey>/...` on the remote — *not* inside the project repo. `projectKey = sha256(user@host:path).slice(0,16)` so two clients adding the same SSH project independently agree on the location without coordination.
- **Manifest-first canonical projectId.** `RemoteSyncEngine.adopt()` is called from `createSshProject` before the local DB insert. It tries `mv -n` to claim `manifest.json` with our candidate UUID; if we lose the race, we read the winner's UUID and insert the local row with it. Avoids any cascading projectId rewrite path.
- **Lazy manifest claim for pre-existing projects.** Projects added before this feature shipped never went through `tryAdoptRemoteSync`, so `_buildState` writes the manifest on first activation using the local projectId. Two pre-existing clients can't fully unify their projectIds this way — the loser logs `local projectId differs from canonical manifest`, which is harmless: tasks still merge under each side's own projectId via the applier's `toTaskInsert(projectId, ...)`.
- **Deterministic PTY session IDs do the rest for free.** Once both clients have the same `(projectId, taskId, conversationId)` tuple, `makePtySessionId` produces the same tmux session name, and the existing `(tmux has-session && attach) || (new && attach)` shell line auto-reattaches.
- **Tombstones.** `deleteTask` writes a `{id, deletedAt}` entry into the `remote-sync` KV namespace. Snapshots include a `deletedTasks` array; the merger unions tombstones across all clients into `MergedSnapshot.deletedTaskIds`; the applier hard-deletes any local task whose id is tombstoned and refuses to re-insert. Tombstones win unconditionally over task rows.
- **Tmux active-discovery.** Every 15s the scheduler runs `tmux list-sessions -F '#{session_name}' | grep '^emdash-'` over SSH, base64url-decodes session names, and emits the active-session set on `remoteSyncActiveSessionsChannel`. The renderer's `useActiveTaskIds(projectId)` hook splits the IDs and renders a green "live agent" dot on each task that has a running session.
- **Channel-leak guard.** `RemoteSyncStore` constructs one `SshFileSystem` and reuses it for the store's lifetime. `SshFileSystem` lazily opens an SFTP channel on first use and caches it; without this reuse, sync's pull/push/tmux-poll cycle leaked SFTP channels every 15-20s and saturated `MaxSessions=10`, breaking unrelated git operations on the same connection.
- **Activation retry.** If `_buildState` throws (e.g. transient channel-open failure), the scheduler retries every 30s instead of giving up for the session. The error log records which step failed (`connect | home | clientId | ensureDirs | ensureManifest`).

**Renderer surface.** `RemoteSyncIndicator` (sidebar) shows a pulsing dot when pulling/pushing and a triangle on error. `LiveAgentDot` on task rows. `TaskManagerStore` subscribes to `tasksUpsertedFromSyncChannel` and `tasksRemovedFromSyncChannel` so synced inserts/deletes show up without restart.

**Known limitations.**

- Conversations between clients with different projectIds are filtered (`remote.projectId !== projectId`) by the applier, so conversation metadata only fully syncs once both clients agree on the canonical projectId. Tasks always sync.
- No reconciliation command yet for unifying divergent projectIds across clients — would need a transactional cascade across `tasks`, `conversations`, `terminals`, `editor_buffers`, `project_remotes`.
- `messages`, `terminals`, `editor_buffers` are intentionally not synced. Claude Code's transcripts on the remote (`~/.claude/projects/...`) are the source of truth for chat history.
- SSH host key verification is still missing upstream in `src/main/core/ssh/build-connect-config.ts` — orthogonal to remote-sync but the same threat model (if you MITM the SSH connection, all of this is moot).

**Tests.** `src/main/core/remote-sync/*.test.ts` covers project-key hashing, snapshot merger (LWW, tiebreak, tombstones), schema parsing, and tmux-name decoding. 24 tests; run only these with `pnpm vitest run src/main/core/remote-sync`.

## Where to add new code

- **New RPC method** — write the handler in `src/main/core/<domain>/operations/<name>.ts` (or wherever the domain colocates them), add it to that domain's `controller.ts`, then wire the controller into `src/main/rpc.ts`. There is no auto-discovery.
- **New view / modal** — register in `src/renderer/core/view/registry.ts` or `src/renderer/core/modal/registry.ts`.
- **Renderer state.** MobX class stores for entity lifecycle (project/task/conversation managers); React Query for cross-cutting RPC fetches. Subscribe to event channels inside `useEffect` cleanup or a store's `dispose()`.
- **Manual IPC in `electron-api.d.ts`** is only for handlers that need `event.sender`. Everything else goes through RPC.

## High-risk areas

- `src/main/core/ssh/` — host key verification, credential handling, connection pooling, `MaxSessions` pressure.
- `src/main/core/pty/` — shell-arg escaping (`src/main/utils/shellEscape.ts:quoteShellArg`), tmux orchestration. Prefer argv arrays over interpolated shell strings.
- `src/main/db/` and `drizzle/` — never hand-edit numbered migrations or `drizzle/meta/`. Always go through `pnpm run db:generate`.
- `electron-builder.config.ts` + auto-updater — affects how installed binaries are replaced; treat any change as a release-engineering concern.

## Renderer state guards

`ProjectStore` and `TaskStore` are mutable MobX class instances with discriminated `kind` states. **Never** `asProvisioned(store)!` or `asMounted(store)!` — use the `useRequireProvisionedTask()` / `useProvisionedTask()` hooks from `task-view-context.tsx` inside the task-view tree, or an explicit null check from the selectors (`task-selectors.ts`, `project-selectors.ts`) elsewhere. State guards must use `kind !== 'ready'`, never enumerate the non-ready cases (a new state would silently fall through). Access task manager via `getTaskManagerStore(projectId)`, not through the project store.

## Conventions to remember

- **Never re-export**; always import from the original source.
- All new RPC methods are auto-registered via the domain's controller — never bypass the router for typed calls.
- Renderer hooks for sync UI (`use-active-task-ids.ts`, `use-remote-sync-status.ts`) cache via React Query and patch the cache on event-channel updates rather than re-polling.
