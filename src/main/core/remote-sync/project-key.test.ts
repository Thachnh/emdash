import { describe, expect, it } from 'vitest';
import { normalizePosixPath, projectKey } from './project-key';

describe('projectKey', () => {
  it('returns the same key for the same triple', () => {
    expect(projectKey('host.example', 'alice', '/srv/repo')).toEqual(
      projectKey('host.example', 'alice', '/srv/repo')
    );
  });

  it('is case-insensitive for host and user', () => {
    expect(projectKey('Host.Example', 'Alice', '/srv/repo')).toEqual(
      projectKey('host.example', 'alice', '/srv/repo')
    );
  });

  it('is sensitive to path differences', () => {
    expect(projectKey('host.example', 'alice', '/srv/repo')).not.toEqual(
      projectKey('host.example', 'alice', '/srv/other')
    );
  });

  it('treats trailing slashes as equivalent', () => {
    expect(projectKey('host.example', 'alice', '/srv/repo/')).toEqual(
      projectKey('host.example', 'alice', '/srv/repo')
    );
  });

  it('collapses repeated slashes', () => {
    expect(projectKey('host.example', 'alice', '/srv//repo')).toEqual(
      projectKey('host.example', 'alice', '/srv/repo')
    );
  });

  it('produces a 16-hex-character key', () => {
    const key = projectKey('host.example', 'alice', '/srv/repo');
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('normalizePosixPath', () => {
  it('returns "/" for empty-equivalent paths', () => {
    expect(normalizePosixPath('/')).toBe('/');
    expect(normalizePosixPath('//')).toBe('/');
  });

  it('removes trailing slashes', () => {
    expect(normalizePosixPath('/foo/bar/')).toBe('/foo/bar');
  });

  it('collapses multiple slashes', () => {
    expect(normalizePosixPath('/foo//bar///baz')).toBe('/foo/bar/baz');
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizePosixPath('\\foo\\bar')).toBe('/foo/bar');
  });
});
