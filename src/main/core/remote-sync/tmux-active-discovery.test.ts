import { describe, expect, it } from 'vitest';
import { makePtySessionId } from '@shared/ptySessionId';
import { makeTmuxSessionName } from '@main/core/pty/tmux-session-name';
import { getActiveSessionIds } from './tmux-active-discovery';

function fakeCtx(stdout: string) {
  return {
    exec: async () => ({ stdout, stderr: '' }),
  } as unknown as Parameters<typeof getActiveSessionIds>[0];
}

describe('getActiveSessionIds', () => {
  it('returns an empty set when tmux returns nothing', async () => {
    const ids = await getActiveSessionIds(fakeCtx(''));
    expect(ids.size).toBe(0);
  });

  it('decodes base64url session names back to the original sessionId', async () => {
    const sessionId = makePtySessionId('p-1', 't-1', 'c-1');
    const tmuxName = makeTmuxSessionName(sessionId);
    const ids = await getActiveSessionIds(fakeCtx(`${tmuxName}\n`));
    expect(ids.has(sessionId)).toBe(true);
  });

  it('skips lines that do not start with the emdash- prefix', async () => {
    const tmuxName = makeTmuxSessionName(makePtySessionId('p', 't', 'c'));
    const stdout = `other-session\n${tmuxName}\nrandom\n`;
    const ids = await getActiveSessionIds(fakeCtx(stdout));
    expect(ids.size).toBe(1);
  });
});
