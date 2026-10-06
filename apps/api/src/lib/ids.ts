/**
 * Identifier generation.
 *
 * UUIDv4 keeps primary keys opaque (no enumeration), sortable-free, and
 * within the shared `IdSchema` limit of 64 characters.
 */

import { randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}
