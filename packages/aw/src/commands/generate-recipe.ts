/**
 * `aw generate recipe <name> --on resource:<resource>.<created|updated|deleted>` and
 * `aw generate recipe <name> --on 'schedule:<cron>' [--tz <iana>]` (issue #1514): writes exactly
 * `recipes/<name>.ts` and `tests/recipes/<name>.test.ts`, adds the recipe to `recipes: [...]` in
 * `app.config.ts`, and records it all in `aw-generated.json`, so `aw destroy recipe <name>` removes
 * exactly that.
 *
 * `--on` is checked before anything is written: its grammar and the resource (one of the app's
 * `resources/`) by the SDK's `renderRecipeSpec`, the cron and the time zone by the project's own
 * `aw-app recipe-on`, since `aw` imports neither the app kit nor croner. Either refusal is a usage
 * error. `trigger:<name>` waits for the entry agent a trigger reaches an app through (O-6).
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  appConfigRecipeLines,
  renderGeneratorTemplate,
  renderRecipeSpec,
  type GeneratedManifest,
} from '@indx-workspace/sdk/project';

import type { LocalCommandContext } from '../command.js';
import { checkRecipeSchedule } from '../generate/app-kit.js';
import { APP_CONFIG_FILE, withAppConfigLines } from '../generate/edits.js';
import {
  carryOut,
  cwdOf,
  generatedApp,
  onlyName,
  refuseRecorded,
  refuseTaken,
  rendered,
  type Generation,
} from '../generate/generation.js';
import { entryNames, readManifest } from '../generate/manifest.js';
import { readTextIfPresent } from '../generate/write.js';
import { errorCode } from '../local-runtime/project.js';
import { CommandRefusedError, UsageError } from '../io.js';

const WHAT = 'aw generate recipe';

/** The resources this app has: the generated ones and every `resources/<name>.ts`. */
async function appResources(cwd: string, manifest: GeneratedManifest): Promise<string[]> {
  let files: string[] = [];
  try {
    files = await readdir(path.join(cwd, 'resources'));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error;
  }
  const written = files.filter((file) => file.endsWith('.ts')).map((file) => file.slice(0, -3));
  return [...new Set([...entryNames(manifest, 'resource'), ...written])].sort();
}

/** `app.config.ts` with the recipe added to `recipes: [...]`, refused when it has no such list. */
async function configWithRecipe(
  cwd: string,
  name: string,
  lines: { readonly import: string; readonly entry: string },
): Promise<string> {
  const text = (await readTextIfPresent(cwd, APP_CONFIG_FILE)) ?? '';
  const config = withAppConfigLines(text, lines, 'recipes');
  if (config === undefined) {
    throw new CommandRefusedError(
      `${APP_CONFIG_FILE} has no recipes: [ ... ] list on lines of its own to add ${name} to, or already imports it`,
      `add ${name} to ${APP_CONFIG_FILE} by hand`,
    );
  }
  return config;
}

export async function runGenerateRecipe(context: LocalCommandContext): Promise<void> {
  const cwd = cwdOf(context, WHAT);
  const name = onlyName(context, WHAT);
  const on = context.args.values.get('on');
  if (on === undefined) {
    throw new UsageError(
      `${WHAT} needs --on resource:<resource>.<created|updated|deleted> or --on 'schedule:<cron>'`,
    );
  }
  const tz = context.args.values.get('tz');
  const manifest = await readManifest(cwd);
  await generatedApp(cwd, manifest);
  refuseRecorded(manifest, 'recipe', name);
  const resources = await appResources(cwd, manifest);
  const spec = rendered(() => renderRecipeSpec(name, { on, tz, resources }));
  if (spec.trigger.kind === 'schedule') {
    await checkRecipeSchedule(spec.trigger.cron, spec.trigger.timezone, {
      cwd,
      env: context.io.env,
      signal: context.signal,
    });
  }
  const lines = appConfigRecipeLines(name);
  const config = await configWithRecipe(cwd, name, lines);
  const generation: Generation = {
    kind: 'recipe',
    name,
    files: renderGeneratorTemplate('recipe', spec.values),
    inPlace: [{ path: APP_CONFIG_FILE, text: config }],
    edits: [
      { path: APP_CONFIG_FILE, added: lines.import },
      { path: APP_CONFIG_FILE, added: lines.entry },
    ],
  };
  await refuseTaken(cwd, generation);
  await carryOut(context, cwd, manifest, generation);
}
