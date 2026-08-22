import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveWorkspaceDir } from '../src/paths.js';

describe('workspace directory resolution', () => {
  it('defaults to a workspace child of the durable data directory', () => {
    expect(resolveWorkspaceDir('/data')).toBe(join('/data', 'workspace'));
  });

  it('honors an explicit override', () => {
    expect(resolveWorkspaceDir('/data', '/mnt/workspace')).toBe('/mnt/workspace');
  });

  it('ignores an empty override', () => {
    expect(resolveWorkspaceDir('/data', '')).toBe(join('/data', 'workspace'));
  });
});
