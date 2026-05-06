import type { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';

const TMUX_PREFIX = 'emdash-';
const TMUX_LIST_CMD =
  "tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^emdash-' || true";

export async function getActiveSessionIds(ctx: SshExecutionContext): Promise<Set<string>> {
  const { stdout } = await ctx.exec('sh', ['-c', TMUX_LIST_CMD]);
  const ids = new Set<string>();
  for (const line of stdout.split('\n')) {
    const name = line.trim();
    if (!name.startsWith(TMUX_PREFIX)) continue;
    try {
      const decoded = Buffer.from(name.slice(TMUX_PREFIX.length), 'base64url').toString('utf8');
      if (decoded) ids.add(decoded);
    } catch {
      // Ignore unparseable entries
    }
  }
  return ids;
}
