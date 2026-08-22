import { join } from 'node:path';

/**
 * Resolve the agent workspace root. It defaults to a workspace child of the durable data
 * directory so that project scratch stays on the writable volume in a read-only container.
 */
export const resolveWorkspaceDir = (dataDir: string, override?: string): string =>
  override && override.length > 0 ? override : join(dataDir, 'workspace');
