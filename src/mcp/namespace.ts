/**
 * Namespace derivation for the MCP memory server.
 *
 * Uses the same algorithm as the shim's `buildEvent` to derive the
 * `/actor/<actor_id>/project/<project_id>/` namespace from the working
 * directory. This is a deliberate duplication — the MCP module cannot
 * import from `src/shim/`.
 *
 * @see Requirements 12.1, 12.2, 10.1–10.4, N11
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';

/**
 * Get the actor ID from the OS, with fallback chain:
 *   os.userInfo().username → process.env.USER → process.env.USERNAME → 'unknown'
 */
export function getActorId(): string {
  try {
    const name = userInfo().username;
    if (name.trim().length > 0) return name;
  } catch {
    // fall through to env vars
  }
  const user = process.env['USER'];
  if (user !== undefined && user.trim().length > 0) return user;
  const username = process.env['USERNAME'];
  if (username !== undefined && username.trim().length > 0) return username;
  return 'unknown';
}

/**
 * Derive the namespace for memory operations from the working directory.
 *
 * Algorithm (identical to shim):
 *   project_id = SHA-256 hex of fs.realpathSync(cwd)
 *   actor_id   = os.userInfo().username (with fallback chain)
 *   namespace  = /actor/<actor_id>/project/<project_id>/
 */
export function deriveNamespace(cwd: string): string {
  const resolved = realpathSync(cwd);
  const projectId = createHash('sha256').update(resolved).digest('hex');
  const actorId = getActorId();
  return `/actor/${actorId}/project/${projectId}/`;
}
