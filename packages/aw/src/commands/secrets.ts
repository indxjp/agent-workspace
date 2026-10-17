import { isReservedSecretName } from '@indx-workspace/contracts/secret-reference';
import { SECRET_NAME_PATTERN } from '@indx-workspace/contracts/secrets';
import { ApiProblemError } from '@indx-workspace/sdk';

import {
  command,
  positional,
  readBody,
  readSecretOverlay,
  requireSecretFromStdin,
  value,
  type Command,
} from '../command.js';
import { CreateSecretBody } from '../inputs.js';
import { CommandRefusedError, UsageError } from '../io.js';

const SECRET_COLUMNS = ['id', 'name', 'algorithm', 'masterKeyId', 'updatedAt'];

/**
 * §5.5 — `aw secrets`. A value is read from stdin or the body only, and never printed. `remove`
 * is refused (`409 secret_in_use`) while a connector or model connection references the secret.
 */
export const secretCommands: readonly Command[] = [
  command('secrets list', '', 'Every secret, metadata only', async ({ client, signal }) => ({
    value: await client.secrets.list({ signal }),
    columns: SECRET_COLUMNS,
  })),
  command(
    'secrets create',
    '--name <NAME> --value-stdin | --file <json>',
    'Store a new secret',
    async (context) => {
      const name = value(context, 'name');
      // BH061-066: a reserved name (PORT, PATH, AW_…) can never be referenced with secret().
      if (name !== undefined && isReservedSecretName(name)) {
        throw new UsageError(
          `${name} is reserved for the local runtime (PORT, PATH and AW_ names), so secret('${name}') could never reference it; choose another name`,
        );
      }
      return {
        value: await context.client.secrets.create(
          await readBody(context, CreateSecretBody, {
            name,
            ...(await readSecretOverlay(context, 'value')),
          }),
          { signal: context.signal },
        ),
      };
    },
  ),
  command(
    'secrets replace',
    '<name|id> --value-stdin',
    "Rotate a secret's value in place",
    async (context) => {
      const target = positional(context, 0, 'name|id');
      const secretValue = await requireSecretFromStdin(context);
      // ADR-0114 S4: an upper-case name (never a UUID) is resolved by the server.
      try {
        return {
          value: await context.client.secrets.replace(
            SECRET_NAME_PATTERN.test(target) ? { name: target } : target,
            secretValue,
            { signal: context.signal },
          ),
        };
      } catch (error) {
        if (
          error instanceof ApiProblemError &&
          error.code === 'secret_not_found' &&
          SECRET_NAME_PATTERN.test(target)
        ) {
          throw new CommandRefusedError(
            `no secret named ${target}`,
            `aw secrets create --name ${target} --value-stdin`,
          );
        }
        throw error;
      }
    },
  ),
  command('secrets remove', '<name|id>', 'Delete a secret nothing references', async (context) => {
    const target = positional(context, 0, 'name|id');
    const { signal } = context;
    // BH061-066: a name is accepted as `secrets replace` accepts one; an exact match only.
    const secretId = SECRET_NAME_PATTERN.test(target)
      ? (await context.client.secrets.list({ name: target, signal })).find(
          (entry) => entry.name === target,
        )?.id
      : target;
    if (secretId === undefined) throw new CommandRefusedError(`no secret named ${target}`);
    await context.client.secrets.remove(secretId, { signal });
    return { value: undefined };
  }),
];
