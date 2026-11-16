import { styleText } from 'node:util';
import { SCRIPTED_MODEL_PREFIX } from '@indx-workspace/contracts/models';
import { LocalPortSchema, type ProjectRead } from '@indx-workspace/contracts/project-file';
import { nonBlank } from '../config.js';
import { UsageError, type CliIo } from '../io.js';
import { freeWebPort, missingKeyLines } from '../local-runtime/environment.js';
import { keyConsole } from '../local-runtime/open-url.js';
import { modelSecretNames } from '../local-runtime/project.js';

export const SANDBOXES = ['local', 'docker'] as const;

/**
 * BH061-012: the web port asked for on the command line (`--port`), else by `PORT` in `aw dev`'s
 * environment; `undefined` when neither is given, and the project file's port applies. A port
 * asked for is pinned, as one in the project file is: a busy one is refused, never moved.
 */
function requestedWebPort(flag: string | undefined, env: CliIo['env']): number | undefined {
  const fromEnv = nonBlank(env['PORT']);
  const [raw, source] =
    flag !== undefined ? [flag, '--port'] : fromEnv !== undefined ? [fromEnv, 'PORT'] : [];
  if (raw === undefined || source === undefined) return undefined;
  const parsed = LocalPortSchema.safeParse(/^[0-9]{1,5}$/u.test(raw.trim()) ? Number(raw) : NaN);
  if (!parsed.success) {
    throw new UsageError(
      `${source} must be a port from 1 to 65535 that is not 4000 or 8080 (the gateway and runner ports)`,
    );
  }
  return parsed.data;
}

/**
 * The web port to start on and the environment to start it with: a requested port (and `PORT` set
 * to it, since the runtime refuses a `PORT` that differs), else the project's port, moved to the
 * next free set when it is unpinned and busy (`moved`).
 */
export async function chooseWebPort(
  flag: string | undefined,
  io: CliIo,
  read: ProjectRead,
): Promise<{
  readonly io: CliIo;
  readonly port: number | undefined;
  readonly moved: Awaited<ReturnType<typeof freeWebPort>>;
}> {
  const requested = requestedWebPort(flag, io.env);
  if (requested !== undefined) {
    return {
      io: { ...io, env: { ...io.env, PORT: String(requested) } },
      port: requested,
      moved: null,
    };
  }
  const moved = await freeWebPort(read, io.env);
  return { io, port: moved?.port, moved };
}

/** The credential a scripted-only project's connections hold; never sent for a `scripted:` id. */
const SCRIPTED_PLACEHOLDER_KEY = 'scripted';

/**
 * Issue #798: with `AW_SCRIPTED_MODELS_DIR` set and every agent on a `scripted:` model, `aw dev`
 * needs no provider key. A connection still holds a credential, so each unset model secret gets a
 * placeholder the gateway never sends anywhere. `undefined` when the project is not scripted-only.
 */
export function withScriptedKeys(
  io: CliIo,
  read: ProjectRead,
  models: readonly (string | null)[],
): CliIo | undefined {
  const scripted =
    nonBlank(io.env['AW_SCRIPTED_MODELS_DIR']) !== undefined &&
    models.length > 0 &&
    models.every((model) => model?.startsWith(SCRIPTED_MODEL_PREFIX) === true);
  if (!scripted) return undefined;
  const unset = modelSecretNames(read).filter((name) => nonBlank(io.env[name]) === undefined);
  return {
    ...io,
    env: {
      ...io.env,
      ...Object.fromEntries(unset.map((name) => [name, SCRIPTED_PLACEHOLDER_KEY])),
    },
  };
}

/** The project file's `engine` and `models`, which a lifted v1 deployment profile has neither of. */
export function projectDefaults(read: ProjectRead) {
  return read.lifted
    ? { defaultEngine: undefined, models: undefined }
    : { defaultEngine: read.project.engine, models: read.project.models };
}

/**
 * Issue #690: on a terminal, when a model key is missing, offer a numbered choice (Enter takes the
 * first): open the provider's console to create a key and paste it, paste one, or skip. A pasted
 * key is read with nothing echoed and goes only into the environment this process hands on (`aw dev`
 * sends it to the runtime over the API, SD17); it is never written to a project file, but the
 * runtime keeps it in its own database and an `aw dev` without the variable runs on it
 * (BH061-051). Skipping, a blank paste, no terminal, or `--quiet` leaves the key missing, and the
 * ready screen says the line to run. Every line fits 80 columns (BH061-070).
 */
export async function withSessionKey(io: CliIo, read: ProjectRead, quiet: boolean): Promise<CliIo> {
  const name = modelSecretNames(read).find((secret) => (io.env[secret] ?? '') === '');
  if (
    name === undefined ||
    quiet ||
    !io.isTty ||
    io.prompt === undefined ||
    io.promptSecret === undefined
  )
    return io;
  const [problem = '', ...fix] = missingKeyLines(name);
  const target = keyConsole(name);
  const plain = (io.env['NO_COLOR'] ?? '') !== '';
  const paint = (format: Parameters<typeof styleText>[0], text: string): string =>
    plain ? text : styleText(format, text, { validateStream: false });
  const options = [
    ...(target === undefined
      ? []
      : [
          {
            id: 'open',
            label: `Open the ${target.provider} console, create a key, then paste it`,
          },
        ]),
    { id: 'paste', label: 'Paste a key now (hidden)' },
    { id: 'skip', label: 'Skip for now' },
  ] as const;
  const indent = ' '.repeat(12);
  io.stdout(
    `  ${paint('red', '✗')} model   ${problem}
` +
      `${indent}the local runtime keeps a pasted key for later starts:
` +
      options
        .map(
          (option, index) => `${indent}  ${paint('bold', `[${String(index + 1)}]`)} ${option.label}
`,
        )
        .join('') +
      `${indent}or set it yourself and restart:
${fix
  .map(
    (line) => `${indent}  ${line}
`,
  )
  .join('')}`,
  );
  let choice: (typeof options)[number]['id'] | undefined;
  for (let attempt = 0; choice === undefined && attempt < 3; attempt += 1) {
    const answer = (await io.prompt(`  choose 1-${String(options.length)} (Enter = 1) › `)).trim();
    choice = answer === '' ? options[0].id : options[Number(answer) - 1]?.id;
    if (choice === undefined)
      io.stdout(`${indent}type 1${options.length > 2 ? ', 2 or 3' : ' or 2'}, or press Enter for 1
`);
  }
  if (choice === undefined)
    io.stdout(`${indent}no choice made: skipped
`);
  if (choice === undefined || choice === 'skip') return io;
  if (choice === 'open' && target !== undefined) {
    io.stdout(`${indent}opening ${target.url}
`);
    if (!((await io.openUrl?.(target.url)) ?? false))
      io.stdout(`${indent}no browser could be opened here: open that link yourself, then paste the key
`);
  }
  const key = (await io.promptSecret('  key › ')).trim();
  if (key === '')
    io.stdout(`${indent}no key pasted: skipped
`);
  return key === '' ? io : { ...io, env: { ...io.env, [name]: key } };
}
