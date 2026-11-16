/**
 * `create --template` (issues #1510, #1511): an app template is the `app` generator's template,
 * the portal's pages over it and, for a preset (`chat`, `wiki`, `crm`, `desk`), the shared parts
 * and the preset's own overlay, with the packages they need and the `aw-generated.json` entries
 * that record them, so `aw destroy` removes exactly what `create` wrote. `create` renders through
 * this without importing `aw`; `aw generate app` pins the same packages.
 */
import {
  APP_PRESETS,
  portalValues,
  type AppPreset,
  type AppPresetResource,
} from './app-presets.js';
import { ProjectRenderError, type ProjectRenderIssue } from './errors.js';
import {
  appConfigLines,
  parseFieldSpecs,
  renderAppSpec,
  renderGeneratorTemplate,
  renderPageSpec,
  renderResourceSpec,
} from './generate.js';
import {
  MIGRATION_JOURNAL_FILE,
  readMigrationJournal,
  serializeMigrationJournal,
  type MigrationJournalEntry,
} from './generated-edits.js';
import {
  addGeneratedEntry,
  EMPTY_GENERATED_MANIFEST,
  GENERATED_MANIFEST_FILE,
  generatedEntryKey,
  serializeGeneratedManifest,
  type GeneratedEdit,
  type GeneratedManifest,
} from './generated-manifest.js';
import { renderTemplateDirectory, type ProjectFile } from './template.js';

/** The app templates `create --template` writes: the portal, and the presets over it. */
export const APP_TEMPLATES = Object.freeze(['portal', 'chat', 'wiki', 'crm', 'desk'] as const);

/** One of {@link APP_TEMPLATES}. */
export type AppTemplate = (typeof APP_TEMPLATES)[number];

/** One package a generated app depends on, at an exact version. */
export interface PinnedPackage {
  /** The `package.json` section it goes in. */
  readonly section: 'dependencies' | 'devDependencies';
  /** The npm name. */
  readonly name: string;
  /** The exact version, never a range. */
  readonly version: string;
}

/**
 * The packages an app needs in `package.json`, at exact versions: the app kit in lock-step with
 * `version`, and the Next.js, React, Drizzle and PostgreSQL versions this release builds and tests
 * the app kit with (`aw`'s `app-kit.test.ts` holds them equal to the repository's), plus
 * dependency-cruiser for the app's import boundary check.
 */
export function appKitPackages(version: string): readonly PinnedPackage[] {
  return Object.freeze([
    { section: 'dependencies', name: '@indx-workspace/app', version },
    { section: 'dependencies', name: 'drizzle-orm', version: '0.45.4' },
    { section: 'dependencies', name: 'next', version: '16.4.3' },
    { section: 'dependencies', name: 'pg', version: '8.23.1' },
    { section: 'dependencies', name: 'react', version: '19.3.1' },
    { section: 'dependencies', name: 'react-dom', version: '19.3.1' },
    { section: 'devDependencies', name: 'dependency-cruiser', version: '18.7.0' },
  ]);
}

/** One script a generated app adds to `package.json`. */
export interface AppScript {
  /** The script's name, as `npm run <name>` runs it. */
  readonly name: string;
  /** The command it runs. */
  readonly command: string;
}

/**
 * The scripts an app adds to `package.json`: `build` is `next build`, which the `Dockerfile` runs
 * (issue #1531), and `image` builds the app's image from that `Dockerfile`, tagged with the app's
 * name, for `aw deploy` to run once it is pushed (issue #1512).
 */
export function appScripts(appName: string): readonly AppScript[] {
  return Object.freeze([
    { name: 'build', command: 'next build' },
    { name: 'image', command: `docker build -t ${appName} .` },
  ]);
}

/** The recorded edit of one script added to `package.json`, as `aw generate app` records it. */
export function scriptEdit(script: AppScript): GeneratedEdit {
  return {
    path: 'package.json',
    added: JSON.stringify({ scripts: { [script.name]: script.command } }),
  };
}

/** The published packages a template's pages import beyond the app kit's, at `version`. */
const TEMPLATE_PACKAGES: readonly string[] = ['@indx-workspace/contracts', '@indx-workspace/react'];

/** The recorded edit of one package added to `package.json`, as `aw generate app` records it. */
function packageEdit(pin: PinnedPackage): GeneratedEdit {
  return {
    path: 'package.json',
    added: JSON.stringify({ [pin.section]: { [pin.name]: pin.version } }),
  };
}

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** What {@link renderAppTemplate} renders. */
export interface RenderedAppTemplate {
  /**
   * The files to write: the project's own (its `package.json` with the packages and scripts
   * added), then the app's, `aw-generated.json` last.
   */
  readonly files: readonly ProjectFile[];
  /** The packages added to the project's `package.json`, the edits the manifest records. */
  readonly packages: readonly PinnedPackage[];
  /** The scripts added to the project's `package.json`, recorded after the packages. */
  readonly scripts: readonly AppScript[];
}

async function hashesOf(files: readonly ProjectFile[]): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(files.map(async (file) => [file.path, await sha256(file.contents)] as const)),
  );
}

/** The app README and a preset's README section, which follows the project's README. */
const README = 'README.md';

/** The app config, which a preset's resources are added to as `aw generate resource` adds them. */
const APP_CONFIG = 'app.config.ts';

/** The app template's pages the portal writes over on purpose. */
const PORTAL_REPLACES: readonly string[] = ['app/layout.tsx', 'app/page.tsx'];

/** One layer of an app template: its files, and the earlier paths it writes over on purpose. */
export interface TemplateLayer {
  /** How a refusal names it: `the portal template`, `the recipes part`. */
  readonly name: string;
  readonly files: readonly ProjectFile[];
  /** The paths an earlier layer wrote that this one writes over; any other repeat is refused. */
  readonly replaces: readonly string[];
}

function byPath(left: ProjectFile, right: ProjectFile): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

/**
 * The files of `layers`, each later layer over the earlier ones, sorted by path.
 *
 * @throws {ProjectRenderError} listing every path a layer writes that an earlier layer already
 *   wrote but its `replaces` does not name, and every path its `replaces` names that no earlier
 *   layer wrote, so a silent shadow is a refusal and never a surprise.
 */
export function mergeTemplateLayers(
  template: string,
  layers: readonly TemplateLayer[],
): readonly ProjectFile[] {
  const written = new Map<string, { readonly file: ProjectFile; readonly layer: string }>();
  const issues: ProjectRenderIssue[] = [];
  for (const layer of layers) {
    for (const path of layer.replaces.filter((replaced) => !written.has(replaced))) {
      issues.push({
        path,
        message: `is replaced by ${layer.name}, but no earlier layer writes it`,
      });
    }
    for (const file of layer.files) {
      const earlier = written.get(file.path);
      if (earlier !== undefined && !layer.replaces.includes(file.path)) {
        issues.push({
          path: file.path,
          message: `is written by ${layer.name}, which ${earlier.layer} already wrote`,
        });
      }
      written.set(file.path, { file, layer: layer.name });
    }
  }
  if (issues.length > 0) throw new ProjectRenderError(`the ${template} template`, issues);
  return [...written.values()].map((entry) => entry.file).sort(byPath);
}

function presetOf(template: AppTemplate): AppPreset | undefined {
  return template === 'portal' ? undefined : APP_PRESETS[template];
}

/** A preset's generated layers: its resources' pages, then its `page/<kind>` page. */
function generatedLayers(preset: AppPreset): TemplateLayer[] {
  const layers = preset.resources.flatMap((resource): TemplateLayer[] =>
    resource.pages === undefined
      ? []
      : [
          {
            name: `the ${resource.name} pages`,
            files: renderGeneratorTemplate(
              'resource-pages',
              renderResourceSpec(resource.name, parseFieldSpecs(resource.pages)),
            ),
            replaces: [],
          },
        ],
  );
  if (preset.page !== undefined) {
    const spec = renderPageSpec(preset.page.name, { kind: preset.page.kind });
    layers.push({
      name: `the ${preset.page.name} page`,
      files: renderGeneratorTemplate(`page/${spec.kind}`, spec.values),
      replaces: [],
    });
  }
  return layers;
}

/** The layers of `template` in order, and the preset's README section, when it has one. */
function templateLayers(
  template: AppTemplate,
  appName: string,
): { readonly layers: readonly TemplateLayer[]; readonly readme: string | undefined } {
  const preset = presetOf(template);
  const values = { ...renderAppSpec(appName), ...portalValues(preset) };
  const directory = (path: string): readonly ProjectFile[] =>
    renderTemplateDirectory(
      new URL(`./templates/${path}/`, import.meta.url),
      values,
      `the ${template} template`,
    );
  const layers: TemplateLayer[] = [
    { name: 'the app template', files: renderGeneratorTemplate('app', values), replaces: [] },
    { name: 'the portal template', files: directory('portal'), replaces: PORTAL_REPLACES },
  ];
  if (preset === undefined) return { layers, readme: undefined };
  const own = directory(`presets/${preset.directory}`);
  return {
    layers: [
      ...layers,
      ...preset.parts.map((part) => ({
        name: `the ${part} part`,
        files: directory(`parts/${part}`),
        replaces: [],
      })),
      ...generatedLayers(preset),
      {
        name: `the ${template} preset`,
        files: own.filter((file) => file.path !== README),
        replaces: preset.replaces,
      },
    ],
    readme: own.find((file) => file.path === README)?.contents,
  };
}

/** Whether `path` is one of `resource`'s: its file, its routes, its pages, or what it owns. */
function ownedBy(resource: AppPresetResource, path: string): boolean {
  return (
    path === `resources/${resource.name}.ts` ||
    path.startsWith(`app/api/${resource.plural}/`) ||
    path.startsWith(`app/${resource.plural}/`) ||
    path === `db/migrations/${resource.migration ?? ''}.sql` ||
    resource.owns.some((owned) => (owned.endsWith('/') ? path.startsWith(owned) : path === owned))
  );
}

/** One generator's share of an app template: the entry it is recorded as, and its edits. */
interface TemplateEntry {
  readonly key: string;
  readonly owns: (path: string) => boolean;
  readonly edits: readonly GeneratedEdit[];
}

/** The journal entry of a preset's migration `tag`, after `previous`, as `aw` appends one. */
function journalEntry(
  tag: string,
  idx: number,
  previous: MigrationJournalEntry | undefined,
): MigrationJournalEntry {
  return {
    idx,
    version: previous?.version ?? '7',
    when: (previous?.when ?? 0) + 1,
    tag,
    breakpoints: true,
  };
}

/** The entry of a preset's `page/<kind>` page, `page:<name>`, as `aw generate page` records it. */
function pageEntry(name: string): TemplateEntry {
  return {
    key: generatedEntryKey('page', name),
    owns: (path) => path === `app/${name}/page.tsx` || path.startsWith(`app/api/${name}/`),
    edits: [],
  };
}

/**
 * The entries a preset's resources and page are recorded as, each resource with the edits
 * `aw generate resource` would have made for it (its two `app.config.ts` lines and its journal
 * entry), so `aw destroy resource <name>` reverts them; and the journal those edits leave.
 */
function presetEntries(
  preset: AppPreset | undefined,
  journalText: string,
): { readonly entries: readonly TemplateEntry[]; readonly journal: string } {
  const journal = readMigrationJournal(journalText);
  if (preset === undefined || journal === undefined) return { entries: [], journal: journalText };
  const added: MigrationJournalEntry[] = [];
  const entries = preset.resources.map((resource): TemplateEntry => {
    const lines = appConfigLines(resource.name);
    const migration =
      resource.migration === undefined
        ? undefined
        : journalEntry(
            resource.migration,
            journal.entries.length + added.length,
            added.at(-1) ?? journal.entries.at(-1),
          );
    if (migration !== undefined) added.push(migration);
    return {
      key: generatedEntryKey('resource', resource.name),
      owns: (path) => ownedBy(resource, path),
      edits: [
        { path: APP_CONFIG, added: lines.import },
        { path: APP_CONFIG, added: lines.entry },
        ...(migration === undefined
          ? []
          : [{ path: MIGRATION_JOURNAL_FILE, added: JSON.stringify(migration) }]),
      ],
    };
  });
  return {
    entries: preset.page === undefined ? entries : [...entries, pageEntry(preset.page.name)],
    journal:
      added.length === 0
        ? journalText
        : serializeMigrationJournal({ ...journal, entries: [...journal.entries, ...added] }),
  };
}

/** `file` with the preset's README section after it, when it is the README. */
function withReadme(file: ProjectFile, readme: string | undefined): ProjectFile {
  return file.path === README && readme !== undefined
    ? { path: file.path, contents: `${file.contents}${readme}` }
    : file;
}

/** What {@link writtenText} writes a file with. */
interface WrittenContext {
  readonly appName: string;
  readonly preset: AppPreset | undefined;
  readonly journal: string;
}

/**
 * A file as written: `app.config.ts` with the preset's resources (as `aw generate resource` adds
 * them) and the journal with their migrations. The manifest records both as they were before,
 * and the resources' entries record the lines added to them.
 */
function writtenText(file: ProjectFile, context: WrittenContext): ProjectFile {
  const { appName, preset, journal } = context;
  if (file.path === MIGRATION_JOURNAL_FILE) return { path: file.path, contents: journal };
  const resources = preset?.resources.map((resource) => resource.name) ?? [];
  if (file.path !== APP_CONFIG || resources.length === 0) return file;
  const config = renderGeneratorTemplate('app', renderAppSpec(appName, resources)).find(
    (rendered) => rendered.path === APP_CONFIG,
  );
  return { path: file.path, contents: config?.contents ?? file.contents };
}

/**
 * Renders `template` for the app `appName`: the `app` template, the portal's pages over it and,
 * for a preset, its shared parts, its generated pages and its own overlay, each later layer
 * writing over an earlier one only where it says so ({@link mergeTemplateLayers}). The app's name
 * is always `appName`, the project's directory name, never the template id. A `README.md` the
 * project already has is kept, as `aw generate app` keeps it; a preset's README section, the
 * commands that build the app on, follows it.
 *
 * `aw-generated.json` records the files as the generators that write them would: a preset's
 * resources as `resource:<name>`, with their `app.config.ts` lines and journal entry as edits, a
 * preset's page as `page:<name>`, and the rest as `app:<appName>` with the package and script
 * edits. The project's own files (`projectFiles`, the shell and setup files `create` renders) come
 * first in the result, `package.json` with the packages and scripts added and `README.md` with the
 * preset's section, and are recorded as they are written as `project:<appName>` (issue #1531), so
 * every file `create` writes is in the manifest.
 *
 * @param project - `appName` and `version` (the `@indx-workspace/*` pins); `projectFiles` are
 *   the project's other files.
 * @throws {ProjectRenderError} when the app name is refused, a layer writes over an earlier one
 *   outside its `replaces`, a template file would take a path the project already has, or
 *   `package.json` pins one of the packages at another version.
 */
export async function renderAppTemplate(
  template: AppTemplate,
  project: {
    readonly appName: string;
    readonly version: string;
    readonly projectFiles?: readonly ProjectFile[];
  },
): Promise<RenderedAppTemplate> {
  const preset = presetOf(template);
  const { layers, readme } = templateLayers(template, project.appName);
  const existing = new Set((project.projectFiles ?? []).map((file) => file.path));
  const files = mergeTemplateLayers(template, layers)
    .filter((file) => !(file.path === README && existing.has(file.path)))
    .map((file) => withReadme(file, readme));
  const taken = files.filter(
    (file) => existing.has(file.path) || file.path === GENERATED_MANIFEST_FILE,
  );
  if (taken.length > 0) {
    throw new ProjectRenderError(
      `the ${template} template`,
      taken.map((file) => ({ path: file.path, message: 'is already written by the project' })),
    );
  }
  const packages = Object.freeze([
    ...appKitPackages(project.version),
    ...TEMPLATE_PACKAGES.map((name): PinnedPackage => ({
      section: 'dependencies',
      name,
      version: project.version,
    })),
  ]);
  const scripts = appScripts(project.appName);
  const { entries, journal } = presetEntries(
    preset,
    files.find((file) => file.path === MIGRATION_JOURNAL_FILE)?.contents ?? '',
  );
  const context: WrittenContext = { appName: project.appName, preset, journal };
  const projectFiles = (project.projectFiles ?? []).map((file) =>
    file.path === 'package.json'
      ? { path: file.path, contents: withAppPackages(file.contents, packages, scripts) }
      : withReadme(file, readme),
  );
  const manifest = await recordedManifest({
    appName: project.appName,
    files,
    entries,
    edits: [...packages.map(packageEdit), ...scripts.map(scriptEdit)],
    projectFiles,
  });
  return Object.freeze({
    files: Object.freeze([
      ...projectFiles,
      ...files.map((file) => writtenText(file, context)),
      Object.freeze({
        path: GENERATED_MANIFEST_FILE,
        contents: serializeGeneratedManifest(manifest),
      }),
    ]),
    packages,
    scripts,
  });
}

/**
 * `aw-generated.json` for an app template: `app:<appName>` with the files no other entry owns (as
 * the generators wrote them, before any entry's edits), each of `entries` with its own, and
 * `project:<appName>` with the project's files as written.
 */
async function recordedManifest(input: {
  readonly appName: string;
  readonly files: readonly ProjectFile[];
  readonly entries: readonly TemplateEntry[];
  readonly edits: readonly GeneratedEdit[];
  readonly projectFiles: readonly ProjectFile[];
}): Promise<GeneratedManifest> {
  const { appName, files, entries, edits, projectFiles } = input;
  const ownerOf = (file: ProjectFile): TemplateEntry | undefined =>
    entries.find((entry) => entry.owns(file.path));
  let manifest = addGeneratedEntry(EMPTY_GENERATED_MANIFEST, generatedEntryKey('app', appName), {
    files: await hashesOf(files.filter((file) => ownerOf(file) === undefined)),
    edits,
  });
  for (const entry of entries) {
    manifest = addGeneratedEntry(manifest, entry.key, {
      files: await hashesOf(files.filter((file) => ownerOf(file) === entry)),
      edits: entry.edits,
    });
  }
  return projectFiles.length === 0
    ? manifest
    : addGeneratedEntry(manifest, generatedEntryKey('project', appName), {
        files: await hashesOf(projectFiles),
        edits: [],
      });
}

/**
 * `package.json`'s text with `packages` added to their sections (created when missing), each
 * section's keys sorted, and `scripts` added after the scripts it has (one it already has under
 * that name is kept), written back with two-space indent and a final newline.
 *
 * @throws {ProjectRenderError} when the text is not a JSON object, or pins one of `packages` at
 *   another version.
 */
export function withAppPackages(
  text: string,
  packages: readonly PinnedPackage[],
  scripts: readonly AppScript[] = [],
): string {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    manifest = undefined;
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new ProjectRenderError('package.json', [
      { path: '(root)', message: 'is not a JSON object' },
    ]);
  }
  const next: Record<string, unknown> = { ...manifest };
  for (const pin of packages) {
    const section = next[pin.section];
    const pins: Record<string, unknown> =
      typeof section === 'object' && section !== null ? { ...section } : {};
    const pinned = pins[pin.name];
    if (pinned !== undefined && pinned !== pin.version) {
      throw new ProjectRenderError('package.json', [
        {
          path: `${pin.section}.${pin.name}`,
          message: `must be ${pin.version}, the app kit's pin`,
        },
      ]);
    }
    pins[pin.name] = pin.version;
    next[pin.section] = Object.fromEntries(
      Object.entries(pins).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  }
  if (scripts.length > 0) {
    const section = next['scripts'];
    const own: Record<string, unknown> =
      typeof section === 'object' && section !== null ? { ...section } : {};
    for (const script of scripts) own[script.name] ??= script.command;
    next['scripts'] = own;
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}
