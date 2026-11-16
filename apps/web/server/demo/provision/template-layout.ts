/**
 * What the deployment keeps in a template workspace besides the demo agent's own sample files, in
 * one reserved folder the copy never reads as sample data: the entry's sample records (one JSON
 * file per record set, `DemoSampleRecords`) and the digest of the seed the template was last filled
 * from, which is how a second seed of the same content is known to change nothing.
 */
import { createHash } from 'node:crypto';

import { DEMO_TEMPLATE_RESERVED_FOLDER } from '@indx-workspace/contracts/demo-operator';

/** The reserved folder: a seed's sample file may not be at or under it (`DemoSeedFileSchema`). */
const DEMO_TEMPLATE_FOLDER = DEMO_TEMPLATE_RESERVED_FOLDER;

/** The file holding the digest of the seed a template was filled from. */
export const DEMO_TEMPLATE_DIGEST_PATH = `${DEMO_TEMPLATE_FOLDER}/seed.sha256`;

/** The folder every connector's record sets are under, with its trailing slash. */
export const RECORDS_PREFIX = `${DEMO_TEMPLATE_FOLDER}/records/`;

/** The folder of one connector's record sets. */
export const recordsFolderOf = (connector: string): string => `${RECORDS_PREFIX}${connector}`;

/** Where a record set is kept: its resource and language name the file. */
export const recordSetPath = (set: {
  readonly connector: string;
  readonly resource: string;
  readonly lang: string;
}): string => `${recordsFolderOf(set.connector)}/${set.resource}.${set.lang}.json`;

/** Whether `path` is the reserved folder or under it. */
export const isReservedPath = (path: string): boolean =>
  path === DEMO_TEMPLATE_FOLDER || path.startsWith(`${DEMO_TEMPLATE_FOLDER}/`);

/** The text `value` is digested as: JSON with the keys of every object in order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The digest of a seed: the same content in any key order is the same digest. */
export function seedDigest(seed: unknown): string {
  return createHash('sha256').update(canonical(seed)).digest('hex');
}
