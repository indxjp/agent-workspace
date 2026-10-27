import { readFile } from 'node:fs/promises';

import {
  CreateStorageConnectionInputSchema,
  StorageConnectionCredentialSchema,
  UpdateStorageConnectionPatchSchema,
  type StorageConnectionCredential,
} from '@indx-workspace/contracts/storage-connections';

import {
  command,
  isOn,
  positional,
  readBody,
  value,
  values,
  type Command,
  type CommandContext,
} from '../command.js';
import { UsageError } from '../io.js';

const CONNECTION_COLUMNS = [
  'id',
  'name',
  'provider',
  'url',
  'allowedPrefixes',
  'writeAllowed',
  'hasCredential',
  'updatedAt',
];
const ENTRY_COLUMNS = ['path', 'kind', 'size'];

/**
 * The credential of a connection, from `--credential-file <path>` or `--credential-file -`
 * (stdin), shaped as `StorageConnectionCredentialSchema`; `undefined` when the flag is absent.
 * It is never a flag value, and every refusal here is a fixed sentence: the file's text, the
 * validator's wording and the path (which may itself be a pasted credential) are never repeated.
 */
async function readCredential(
  context: CommandContext,
): Promise<StorageConnectionCredential | undefined> {
  const source = value(context, 'credential-file');
  if (source === undefined) return undefined;
  let text: string;
  if (source === '-') {
    text = await context.readStdin('--credential-file -');
  } else {
    try {
      text = await readFile(source, 'utf8');
    } catch {
      throw new UsageError('could not read the --credential-file');
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UsageError('the credential is not JSON');
  }
  const parsed = StorageConnectionCredentialSchema.safeParse(json);
  if (!parsed.success) throw new UsageError('the credential is not a storage credential');
  return parsed.data;
}

async function connectionOf(context: CommandContext) {
  const target = positional(context, 0, 'name|id');
  return context.client.storage.connections.get(target, { signal: context.signal });
}

/** `<name>` or `<name>/<prefix>`: split on the first `/` only, the prefix is passed on unchanged. */
function splitTarget(target: string): { name: string; prefix: string | undefined } {
  const slash = target.indexOf('/');
  if (slash === -1) return { name: target, prefix: undefined };
  const prefix = target.slice(slash + 1);
  return { name: target.slice(0, slash), prefix: prefix === '' ? undefined : prefix };
}

/**
 * The storage design, §06 Phase 5 — `aw storage`. A credential is read from a file or stdin only
 * and never printed; the API answers `hasCredential`, not the secret.
 */
export const storageCommands: readonly Command[] = [
  command(
    'storage connections list',
    '',
    'Every storage connection',
    async ({ client, signal }) => ({
      value: await client.storage.connections.list({ signal }),
      columns: CONNECTION_COLUMNS,
    }),
  ),
  command('storage connections get', '<name|id>', 'One storage connection', async (context) => ({
    value: await connectionOf(context),
  })),
  command(
    'storage connections create',
    '--name <name> --storage-url <url> --allow <prefix> [--allow …] [--write-allowed] [--credential-file <path|->]',
    'Connect a bucket or folder; the credential is read from a file or stdin, never a flag',
    async (context) => {
      const credential = await readCredential(context);
      const allowed = values(context, 'allow');
      const body = await readBody(context, CreateStorageConnectionInputSchema, {
        name: value(context, 'name'),
        url: value(context, 'storage-url'),
        allowedPrefixes: allowed.length === 0 ? undefined : allowed,
        writeAllowed: isOn(context, 'write-allowed') ? true : undefined,
        credential,
      });
      return {
        value: await context.client.storage.connections.create(
          { ...body, allowedPrefixes: [...body.allowedPrefixes] },
          { signal: context.signal },
        ),
      };
    },
  ),
  command(
    'storage connections update',
    '<name|id> [--file <json>] [--name <name>] [--storage-url <url>] [--allow <prefix> …] [--credential-file <path|->]',
    'Rename or reconfigure a connection (writeAllowed through --file)',
    async (context) => {
      const credential = await readCredential(context);
      const allowed = values(context, 'allow');
      const { allowedPrefixes, ...patch } = await readBody(
        context,
        UpdateStorageConnectionPatchSchema,
        {
          name: value(context, 'name'),
          url: value(context, 'storage-url'),
          allowedPrefixes: allowed.length === 0 ? undefined : allowed,
          credential,
        },
      );
      const connection = await connectionOf(context);
      return {
        value: await context.client.storage.connections.update(
          connection.id,
          allowedPrefixes === undefined
            ? patch
            : { ...patch, allowedPrefixes: [...allowedPrefixes] },
          { signal: context.signal },
        ),
      };
    },
  ),
  command(
    'storage connections remove',
    '<name|id>',
    'Delete a connection and its credential; refused while an agent holds a grant',
    async (context) => {
      const connection = await connectionOf(context);
      await context.client.storage.connections.remove(connection.id, { signal: context.signal });
      return { value: undefined };
    },
  ),
  command(
    'storage connections credential',
    '<name|id> --credential-file <path|->',
    'Replace the stored credential, read from a file or stdin',
    async (context) => {
      const credential = await readCredential(context);
      if (credential === undefined) {
        throw new UsageError(
          '--credential-file is required: the credential is read from a file or stdin',
        );
      }
      const connection = await connectionOf(context);
      return {
        value: await context.client.storage.connections.rotateCredential(
          connection.id,
          credential,
          { signal: context.signal },
        ),
      };
    },
  ),
  command(
    'storage connections test',
    '<name|id>',
    'Open the connection and list one entry of an allowed folder',
    async (context) => {
      const connection = await connectionOf(context);
      const outcome = await context.client.storage.connections.test(connection.id, {
        signal: context.signal,
      });
      return { value: outcome, failed: !outcome.ok };
    },
  ),
  command(
    'storage ls',
    '<name>[/<prefix>]',
    "List a connection's folder (every page); without a prefix, its allowed folders",
    async (context) => {
      const { name, prefix } = splitTarget(positional(context, 0, 'name[/prefix]'));
      if (name === '') throw new UsageError('<name[/prefix]> must start with a connection name');
      const connection = await context.client.storage.connections.get(name, {
        signal: context.signal,
      });
      const entries = [];
      for await (const entry of context.client.storage.connections.browse(connection.id, {
        ...(prefix === undefined ? {} : { prefix }),
        signal: context.signal,
      })) {
        entries.push(entry);
      }
      return { value: entries, columns: ENTRY_COLUMNS };
    },
  ),
];
