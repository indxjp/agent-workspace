/**
 * `aw generate app|resource|agent|page|recipe|channel` and `aw destroy` (issues #1505, #1507, #1514, #1519): F-10's generators, local
 * commands with no control plane. Each renders its files from the SDK's templates (the same
 * renderer `create` uses), refuses before writing anything if a path is taken, writes them, makes
 * its one-line edits to `app.config.ts`, `package.json`, the migration journal or a resource's
 * route files, and records it
 * all with each file's sha256 in `aw-generated.json`, so `aw destroy` removes exactly that.
 *
 * `aw` never imports the app kit: a resource's migration SQL comes from the project's own
 * `aw-app sql` (`../generate/app-kit.ts`).
 */
import path from 'node:path';

import {
  appConfigLines,
  appScripts,
  parseFieldSpecs,
  renderAgentSpec,
  renderAppSpec,
  renderGeneratorTemplate,
  renderPageSpec,
  renderResourceSpec,
  scriptEdit,
  type FieldSpec,
  type GeneratedEdit,
  type GeneratedManifest,
} from '@indx-workspace/sdk/project';

import { command, type LocalCommand, type LocalCommandContext } from '../command.js';
import { appKitPackages, resourceTableSql, type PinnedPackage } from '../generate/app-kit.js';
import { runDestroy } from '../generate/destroy.js';
import {
  APP_CONFIG_FILE,
  JOURNAL_FILE,
  journalEdit,
  missingScripts,
  nextJournalEntry,
  PACKAGE_FILE,
  packageEdit,
  pinState,
  readJournal,
  readPackageManifest,
  serializeJournal,
  withAppConfigLines,
  withPackages,
  type PackageManifest,
} from '../generate/edits.js';
import {
  carryOut,
  cwdOf,
  generatedApp,
  knownResource,
  onlyName,
  refuseRecorded,
  refuseTaken,
  rendered,
  unknownResources,
  type Generation,
  type InPlaceEdit,
} from '../generate/generation.js';
import { entryNames, readManifest } from '../generate/manifest.js';
import { occupied, readTextIfPresent } from '../generate/write.js';
import { CommandRefusedError, UsageError } from '../io.js';
import { runGenerateChannel } from './generate-channel.js';
import { runGenerateRecipe } from './generate-recipe.js';

/** The app template's README section: kept when the project already has a README. */
const README = 'README.md';

/** `package.json` read, refusing one aw cannot add packages to. */
function packageManifest(text: string): PackageManifest {
  const manifest = readPackageManifest(text);
  if (manifest === undefined) {
    throw new CommandRefusedError(`${PACKAGE_FILE} is not a JSON object aw can add packages to`);
  }
  return manifest;
}

/** The packages `package.json` lacks, refusing one it pins at another version. */
function packagesToAdd(text: string): readonly PinnedPackage[] {
  const manifest = packageManifest(text);
  const pins = appKitPackages();
  const conflicting = pins.filter((pin) => pinState(manifest, pin) === 'conflicting');
  if (conflicting.length > 0) {
    throw new CommandRefusedError(
      `${PACKAGE_FILE} pins ${conflicting.map((pin) => pin.name).join(', ')} at another version than the app kit needs`,
      `set them to ${conflicting.map((pin) => `${pin.name}@${pin.version}`).join(' ')}`,
    );
  }
  return pins.filter((pin) => pinState(manifest, pin) === 'missing');
}

async function runGenerateApp(context: LocalCommandContext): Promise<void> {
  const cwd = cwdOf(context, 'aw generate app');
  const name = onlyName(context, 'aw generate app');
  const files = rendered(() => renderGeneratorTemplate('app', renderAppSpec(name)));
  const manifest = await readManifest(cwd);
  const [existingApp] = entryNames(manifest, 'app');
  if (existingApp !== undefined) {
    throw new CommandRefusedError(`this project already has the app ${existingApp}`);
  }
  const packageText = await readTextIfPresent(cwd, PACKAGE_FILE);
  if (packageText === undefined) {
    throw new CommandRefusedError(`there is no ${PACKAGE_FILE} here`, 'npm init -y');
  }
  const added = packagesToAdd(packageText);
  // A script the project already has under that name is the developer's, and stays.
  const wanted = appScripts(name);
  const scripts = missingScripts(packageManifest(packageText), wanted);
  // The README section is written only where the project has no README of its own yet.
  const keepReadme = await occupied(path.join(cwd, README));
  const written = files.filter((file) => !(keepReadme && file.path === README));
  const generation: Generation = {
    kind: 'app',
    name,
    files: written,
    inPlace:
      added.length === 0 && scripts.length === 0
        ? []
        : [{ path: PACKAGE_FILE, text: withPackages(packageText, added, scripts) ?? packageText }],
    edits: [...added.map(packageEdit), ...scripts.map(scriptEdit)],
  };
  await refuseTaken(cwd, generation);
  await carryOut(context, cwd, manifest, generation);
  if (keepReadme) context.io.stdout(`kept the existing ${README}\n`);
  for (const script of wanted.filter((each) => !scripts.includes(each))) {
    context.io.stdout(`kept the existing ${PACKAGE_FILE} script ${script.name}\n`);
  }
  if (added.length > 0) context.io.stderr('next: npm install\n');
}

/** The `ref()` targets that name no resource of this app (the new one counts). */
async function unknownRefs(
  cwd: string,
  manifest: GeneratedManifest,
  name: string,
  specs: readonly FieldSpec[],
): Promise<string[]> {
  const targets = specs.flatMap((spec) => (spec.type === 'ref' ? spec.args.slice(0, 1) : []));
  return unknownResources(
    cwd,
    manifest,
    targets.filter((target) => target !== name),
  );
}

/** The two in-place edits of `generate resource`: `app.config.ts` and the migration journal. */
async function resourceEdits(
  cwd: string,
  name: string,
): Promise<{
  readonly inPlace: readonly InPlaceEdit[];
  readonly edits: readonly GeneratedEdit[];
  readonly tag: string;
}> {
  const lines = appConfigLines(name);
  const config = withAppConfigLines((await readTextIfPresent(cwd, APP_CONFIG_FILE)) ?? '', lines);
  if (config === undefined) {
    throw new CommandRefusedError(
      `${APP_CONFIG_FILE} has no resources: [ ... ] list on lines of its own to add ${name} to, or already imports it`,
      `add ${name} to ${APP_CONFIG_FILE} by hand`,
    );
  }
  const journal = readJournal((await readTextIfPresent(cwd, JOURNAL_FILE)) ?? '');
  if (journal === undefined) {
    throw new CommandRefusedError(
      `${JOURNAL_FILE} is missing or is not a migration journal whose entries count up from 0`,
      `restore ${JOURNAL_FILE} from version control`,
    );
  }
  const entry = nextJournalEntry(journal, `${name}s`);
  return {
    inPlace: [
      { path: APP_CONFIG_FILE, text: config },
      {
        path: JOURNAL_FILE,
        text: serializeJournal({ ...journal, entries: [...journal.entries, entry] }),
      },
    ],
    edits: [
      { path: APP_CONFIG_FILE, added: lines.import },
      { path: APP_CONFIG_FILE, added: lines.entry },
      journalEdit(entry),
    ],
    tag: entry.tag,
  };
}

async function runGenerateResource(context: LocalCommandContext): Promise<void> {
  const cwd = cwdOf(context, 'aw generate resource');
  const [name = '', ...fieldArguments] = context.positionals;
  const board = context.args.values.get('board');
  const specs = rendered(() => parseFieldSpecs(fieldArguments));
  const values = rendered(() =>
    renderResourceSpec(name, specs, board === undefined ? {} : { board }),
  );
  const manifest = await readManifest(cwd);
  const appName = await generatedApp(cwd, manifest);
  refuseRecorded(manifest, 'resource', name);
  const unknown = await unknownRefs(cwd, manifest, name, specs);
  if (unknown.length > 0) {
    throw new CommandRefusedError(
      `a ref() field names no resource of this app: ${unknown.join(', ')}`,
      `aw generate resource ${unknown[0] ?? ''} <field:type>... first`,
    );
  }
  const { inPlace, edits, tag } = await resourceEdits(cwd, name);
  const sql = await resourceTableSql(
    appName,
    { name, fields: specs, ...(board === undefined ? {} : { board }) },
    { cwd, env: context.io.env, signal: context.signal },
  );
  const generation: Generation = {
    kind: 'resource',
    name,
    files: [
      ...renderGeneratorTemplate('resource', values),
      ...renderGeneratorTemplate('resource-pages', values),
      { path: `db/migrations/${tag}.sql`, contents: sql },
    ],
    inPlace,
    edits,
  };
  await refuseTaken(cwd, generation);
  await carryOut(context, cwd, manifest, generation);
}

/** `--tools a,b`: the resources the agent's instructions name. */
function toolResources(context: LocalCommandContext): string[] {
  const tools = context.args.values.get('tools');
  if (tools === undefined) {
    throw new UsageError('aw generate agent needs --tools <resource>[,<resource>...]');
  }
  return tools
    .split(',')
    .map((resource) => resource.trim())
    .filter((resource) => resource !== '');
}

async function runGenerateAgent(context: LocalCommandContext): Promise<void> {
  const cwd = cwdOf(context, 'aw generate agent');
  const name = onlyName(context, 'aw generate agent');
  const resources = toolResources(context);
  const manifest = await readManifest(cwd);
  const appName = await generatedApp(cwd, manifest);
  refuseRecorded(manifest, 'agent', name);
  const values = rendered(() => renderAgentSpec(name, { appName, resources }));
  const unknown = await unknownResources(cwd, manifest, resources);
  if (unknown.length > 0) {
    throw new CommandRefusedError(
      `--tools names no resource of this app: ${unknown.join(', ')}`,
      `aw generate resource ${unknown[0] ?? ''} <field:type>... first`,
    );
  }
  const generation: Generation = {
    kind: 'agent',
    name,
    files: renderGeneratorTemplate('agent', values),
    inPlace: [],
    edits: [],
  };
  await refuseTaken(cwd, generation);
  await carryOut(context, cwd, manifest, generation);
}

/** The resource whose own pages, `app/<plural>/`, a page of this name would collide with. */
async function pluralOwner(
  cwd: string,
  manifest: GeneratedManifest,
  name: string,
): Promise<string | undefined> {
  if (!name.endsWith('s')) return undefined;
  const resource = name.slice(0, -1);
  return (await knownResource(cwd, manifest, resource)) ? resource : undefined;
}

async function runGeneratePage(context: LocalCommandContext): Promise<void> {
  const cwd = cwdOf(context, 'aw generate page');
  const name = onlyName(context, 'aw generate page');
  const kind = context.args.values.get('kind');
  if (kind === undefined) {
    throw new UsageError('aw generate page needs --kind dashboard|list|custom');
  }
  const resource = context.args.values.get('resource');
  const spec = rendered(() => renderPageSpec(name, { kind, resource }));
  const manifest = await readManifest(cwd);
  await generatedApp(cwd, manifest);
  refuseRecorded(manifest, 'page', name);
  const owner = await pluralOwner(cwd, manifest, name);
  if (owner !== undefined) {
    throw new CommandRefusedError(
      `app/${name}/ holds the pages of the resource ${owner}`,
      'pick another page name',
    );
  }
  if (resource !== undefined && !(await knownResource(cwd, manifest, resource))) {
    throw new CommandRefusedError(
      `--resource names no resource of this app: ${resource}`,
      `aw generate resource ${resource} <field:type>... first`,
    );
  }
  const generation: Generation = {
    kind: 'page',
    name,
    files: renderGeneratorTemplate(`page/${spec.kind}`, spec.values),
    inPlace: [],
    edits: [],
  };
  await refuseTaken(cwd, generation);
  await carryOut(context, cwd, manifest, generation);
}

/**
 * Issues #1505 and #1507: the generators and their undo. Each writes ordinary code the developer owns, and
 * records it in `aw-generated.json`; `aw destroy` shows what it would remove and removes it only
 * with `--yes`, refusing a file edited since.
 */
export const generateCommands: readonly LocalCommand[] = [
  command(
    'generate app',
    '<name>',
    'Write a portal app here: app.config.ts, its MCP route, its first migration and CI; pins the app kit in package.json',
    { controlPlane: 'none', run: runGenerateApp },
  ),
  command(
    'generate resource',
    '<name> <field:type>... [--board <field>]',
    'Write a resource, its migration, its two route files, its list (a board with --board), detail, edit and new pages, and its test; field types: text[(max)], richText, number[(min,max)], money(CUR), bool, date, dateTime, enum(a,b), person, ref(resource), files, tags, ? for optional',
    { controlPlane: 'none', run: runGenerateResource },
  ),
  command(
    'generate agent',
    '<name> --tools <resource>[,<resource>...]',
    "Write an agent on the app's MCP connector; --tools names the resources its instructions describe and does not restrict its tools (every call is still limited to what the person may do)",
    { controlPlane: 'none', run: runGenerateAgent },
  ),
  command(
    'generate page',
    '<name> --kind dashboard|list|custom [--resource <resource>]',
    'Write app/<name>/page.tsx from the app kit parts: a dashboard placeholder, a list of --resource, or an empty page of your own',
    { controlPlane: 'none', run: runGeneratePage },
  ),
  command(
    'generate recipe',
    "<name> --on resource:<resource>.<created|updated|deleted>|'schedule:<cron>' [--tz <iana>]",
    "Write recipes/<name>.ts and its test, started by a resource's committed write or a cron schedule (UTC unless --tz), and add it to app.config.ts",
    { controlPlane: 'none', run: runGenerateRecipe },
  ),
  command(
    'generate channel',
    '<resource> [--key <refField>]',
    "Bind a resource to a realtime channel: write channels/<resource>.ts keyed on its ref() field (--key, else the first ref() to another resource), its events route and its ChannelView page, and pass { publish } in the resource's two route files",
    { controlPlane: 'none', run: runGenerateChannel },
  ),
  command(
    'destroy',
    '<app|resource|agent|page|recipe|channel|blueprint> <name> [--yes]',
    'Show what aw generate or aw blueprint add wrote for it, and with --yes remove it; refuses files edited since',
    { controlPlane: 'none', run: runDestroy },
  ),
];
