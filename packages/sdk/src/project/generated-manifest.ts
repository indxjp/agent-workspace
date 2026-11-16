/**
 * `aw-generated.json` (issue #1505): what a generator wrote, so `aw destroy` removes exactly that
 * and refuses a file edited since. Each entry, keyed `<kind>:<name>`, lists the files it wrote
 * with their sha256 and the one-line edits it made to files it did not write (an import added to
 * `app.config.ts`, or, since issue #1519, a line of a resource's route file `replaced` by one that
 * passes `{ publish }`). The file is committed with the project; `create` records its entries through
 * the same helpers, so both write the same manifest. An app blueprint's entry, `blueprint:<name>`
 * (ADR-0166 D6), also records the package it came from (`source`) and where each of its migrations
 * landed (`migrations`); only that kind may carry them.
 *
 * Pure: parsing, serialising and changing a manifest touch no file and compute no hash.
 */
import { z } from 'zod';

import { ProjectRenderError, type ProjectRenderIssue } from './errors.js';

/** The manifest's file name, at the project root. */
export const GENERATED_MANIFEST_FILE = 'aw-generated.json';

/**
 * The kinds of thing a generator writes, the first half of an entry's key. `project` is what
 * `create --template` writes besides the app (issue #1531): `package.json`, the project file, the
 * starter agent and the rest of the shell, so every file `create` writes is recorded. `aw destroy`
 * refuses it: those files are the project itself. `blueprint` is an installed app blueprint
 * (ADR-0166): its parts, its migrations and its wiring edits.
 */
export const GENERATED_ENTRY_KINDS = Object.freeze([
  'app',
  'resource',
  'agent',
  'page',
  'recipe',
  'channel',
  'project',
  'blueprint',
] as const);

/** One of {@link GENERATED_ENTRY_KINDS}. */
export type GeneratedEntryKind = (typeof GENERATED_ENTRY_KINDS)[number];

/** The most entries, and files or edits per entry, a manifest holds: far above any real app. */
const MANIFEST_MAX_ENTRIES = 1000;
const ENTRY_MAX_FILES = 200;

/** `<kind>:<name>`, the name a kebab or snake_case name key. */
const ENTRY_KEY =
  /^(?:app|resource|agent|page|recipe|channel|project|blueprint):[a-z0-9][a-z0-9_-]{0,63}$/u;

/** The kind whose entries carry `source` and `migrations`, and the only one that may. */
const BLUEPRINT_KEY_PREFIX = 'blueprint:';

/**
 * A path relative to the project root, with `/` separators: no leading `/`, no `.` or `..`
 * segment, no backslash, no empty segment. A destroy deletes these paths, so none may leave the
 * project.
 */
export const ProjectPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.includes('\\') &&
      !path.includes('\0') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    { message: 'must be a path inside the project, relative, with "/" separators' },
  );

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, 'must be a lower-case hex sha256');

const OneLineSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine((line) => !/[\r\n]/u.test(line), { message: 'must be one line' });

const GeneratedEditSchema = z.strictObject({
  path: ProjectPathSchema,
  /** The line the generator added, verbatim; one line, so it is reverted only if still present. */
  added: OneLineSchema,
  /**
   * The line `added` took the place of, when it replaced one rather than being inserted: a revert
   * puts it back, only while `added` is still there verbatim.
   */
  replaced: OneLineSchema.optional(),
});

/**
 * An exact semver, `1.2.0` or `1.2.0-beta.1`: no range, no `v`, no build metadata (npm drops it).
 * semver.org 2.0.0's grammar without the `+build` suffix.
 */
export const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;

/**
 * Where an installed app blueprint came from (ADR-0166 D6): its npm package, the exact version
 * installed, and npm's sha512 integrity of the tarball, which a later fetch of that same version
 * must match.
 */
const BlueprintSourceSchema = z.strictObject({
  package: z
    .string()
    .max(214)
    .regex(
      /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u,
      'must be an npm package name, lower case, optionally scoped',
    ),
  version: z.string().max(256).regex(EXACT_SEMVER, 'must be an exact semver version'),
  integrity: z
    .string()
    .max(256)
    .regex(/^sha512-[A-Za-z0-9+/]+=*$/u, "must be npm's sha512-<base64> integrity"),
});

/** Where an installed app blueprint came from: `{ package, version, integrity }`. */
export type BlueprintSource = Readonly<z.infer<typeof BlueprintSourceSchema>>;

const GeneratedEntrySchema = z.strictObject({
  files: z
    .record(ProjectPathSchema, Sha256Schema)
    .refine((files) => Object.keys(files).length <= ENTRY_MAX_FILES, {
      message: `an entry lists at most ${String(ENTRY_MAX_FILES)} files`,
    }),
  edits: z.array(GeneratedEditSchema).max(ENTRY_MAX_FILES),
  /** A `blueprint:<name>` entry's package (ADR-0166 D6): required there, refused elsewhere. */
  source: BlueprintSourceSchema.optional(),
  /**
   * A `blueprint:<name>` entry's migrations: each one's path in the package, mapped to the path it
   * was written to in the app. Required there (it may be empty), refused elsewhere.
   */
  migrations: z
    .record(ProjectPathSchema, ProjectPathSchema)
    .refine((migrations) => Object.keys(migrations).length <= ENTRY_MAX_FILES, {
      message: `an entry lists at most ${String(ENTRY_MAX_FILES)} migrations`,
    })
    .optional(),
});

/** Requires `source` and `migrations` on a blueprint entry, and refuses them on any other. */
function checkBlueprintFields(
  entries: Readonly<Record<string, z.infer<typeof GeneratedEntrySchema>>>,
  context: z.RefinementCtx,
): void {
  for (const [key, entry] of Object.entries(entries)) {
    const isBlueprint = key.startsWith(BLUEPRINT_KEY_PREFIX);
    for (const field of ['source', 'migrations'] as const) {
      const present = entry[field] !== undefined;
      if (isBlueprint === present) continue;
      context.addIssue({
        code: 'custom',
        path: [key, field],
        message: isBlueprint
          ? 'is required on a blueprint entry'
          : 'is carried only by a blueprint entry',
      });
    }
  }
}

const GeneratedManifestSchema = z.strictObject({
  version: z.literal(1),
  entries: z
    .record(
      z
        .string()
        .regex(
          ENTRY_KEY,
          'must be <app|resource|agent|page|recipe|channel|project|blueprint>:<name>',
        ),
      GeneratedEntrySchema,
    )
    .refine((entries) => Object.keys(entries).length <= MANIFEST_MAX_ENTRIES, {
      message: `a manifest holds at most ${String(MANIFEST_MAX_ENTRIES)} entries`,
    })
    .superRefine(checkBlueprintFields),
});

/** One edit a generator made to a file it did not write. */
export type GeneratedEdit = Readonly<z.infer<typeof GeneratedEditSchema>>;

/**
 * What one generator run wrote: each file's sha256, and its one-line edits. A `blueprint:<name>`
 * entry also has its `source` and its `migrations`.
 */
export interface GeneratedEntry {
  readonly files: Readonly<Record<string, string>>;
  readonly edits: readonly GeneratedEdit[];
  readonly source?: BlueprintSource | undefined;
  readonly migrations?: Readonly<Record<string, string>> | undefined;
}

/** The parsed `aw-generated.json`. */
export interface GeneratedManifest {
  readonly version: 1;
  readonly entries: Readonly<Record<string, GeneratedEntry>>;
}

/** The manifest of a project nothing has been generated in yet. */
export const EMPTY_GENERATED_MANIFEST: GeneratedManifest = Object.freeze({
  version: 1,
  entries: Object.freeze({}),
});

/** The key of an entry: `resource:ticket`. */
export function generatedEntryKey(kind: GeneratedEntryKind, name: string): string {
  return `${kind}:${name}`;
}

function refusal(issues: readonly ProjectRenderIssue[]): ProjectRenderError {
  return new ProjectRenderError(GENERATED_MANIFEST_FILE, issues);
}

function frozenManifest(entries: Readonly<Record<string, GeneratedEntry>>): GeneratedManifest {
  const byKey = (
    [left]: readonly [string, unknown],
    [right]: readonly [string, unknown],
  ): number => (left < right ? -1 : left > right ? 1 : 0);
  const sorted = Object.entries(entries)
    .sort(byKey)
    .map(
      ([key, entry]) =>
        [
          key,
          Object.freeze({
            files: Object.freeze(Object.fromEntries(Object.entries(entry.files).sort(byKey))),
            edits: Object.freeze(entry.edits.map((edit) => Object.freeze({ ...edit }))),
            ...(entry.source === undefined ? {} : { source: Object.freeze({ ...entry.source }) }),
            ...(entry.migrations === undefined
              ? {}
              : {
                  migrations: Object.freeze(
                    Object.fromEntries(Object.entries(entry.migrations).sort(byKey)),
                  ),
                }),
          }),
        ] as const,
    );
  return Object.freeze({ version: 1, entries: Object.freeze(Object.fromEntries(sorted)) });
}

/**
 * Reads `aw-generated.json`. A file that is not JSON, or does not match the schema exactly (an
 * unknown key included), is refused: the caller must not fall back to an empty manifest, which
 * would let a destroy forget what it may delete.
 *
 * @returns The manifest, its entries and files sorted, frozen.
 * @throws {ProjectRenderError} naming each refused place (dotted path, `(root)` for the file).
 */
export function parseGeneratedManifest(text: string): GeneratedManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw refusal([{ path: '(root)', message: 'is not JSON; restore it from version control' }]);
  }
  const parsed = GeneratedManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw refusal(
      parsed.error.issues.map((issue) => ({
        path: issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return frozenManifest(parsed.data.entries);
}

/** Writes a manifest as `aw-generated.json`'s text: sorted keys, two-space indent, final newline. */
export function serializeGeneratedManifest(manifest: GeneratedManifest): string {
  return `${JSON.stringify(frozenManifest(manifest.entries), null, 2)}\n`;
}

/**
 * Adds one entry.
 *
 * @throws {ProjectRenderError} when the key is malformed, the entry is refused by the schema, or
 *   the key is already recorded (the generator already wrote it).
 */
export function addGeneratedEntry(
  manifest: GeneratedManifest,
  key: string,
  entry: GeneratedEntry,
): GeneratedManifest {
  if (Object.hasOwn(manifest.entries, key)) {
    throw refusal([{ path: key, message: 'is already generated; destroy it first' }]);
  }
  const next = GeneratedManifestSchema.safeParse({
    version: 1,
    entries: { ...manifest.entries, [key]: entry },
  });
  if (!next.success) {
    throw refusal(
      next.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return frozenManifest(next.data.entries);
}

/**
 * Removes one entry.
 *
 * @throws {ProjectRenderError} when the key is not recorded.
 */
export function removeGeneratedEntry(manifest: GeneratedManifest, key: string): GeneratedManifest {
  if (!Object.hasOwn(manifest.entries, key)) {
    throw refusal([{ path: key, message: 'was not generated, so there is nothing to remove' }]);
  }
  return frozenManifest(
    Object.fromEntries(Object.entries(manifest.entries).filter(([name]) => name !== key)),
  );
}
