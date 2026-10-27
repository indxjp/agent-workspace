/**
 * `apps/runner/src/resources.ts` — materialise one run's granted files and skills.
 *
 * ## What ENG-04b (#325) changed here
 *
 * This file used to write skills to `${request.scope.configDir}/skills/<name>/` and to refuse a
 * tenant file whose first path segment was `.claude`. Both are statements about the Claude Agent
 * SDK's directory layout, in an application that is not allowed to know an engine exists
 * (`dependency-cruiser.config.mjs`'s `runner-reaches-engine-adapters-only-through-engines-ts`), and
 * ENG-04 (#324) recorded them as its Deviation 8.
 *
 * The division now is the one the port states: **the engine says where, the runner does the
 * writing.** `AgentEngine.placeSkills` answers with one workspace-relative path per skill file,
 * `@agent-workspace/engine`'s `skillPlacementVerdict` checks every answer against the directory the
 * adapter declared, and everything below this line — symlink refusal, read-only modes, removing what
 * a revoked assignment left behind — is engine-neutral and unchanged.
 *
 * ## Why the manifest records paths and not only names
 *
 * Before ENG-04b the revocation pass knew a skill's directory (`<configDir>/skills/<name>`) and
 * could delete the tree. It cannot any more, and it must not guess: a manifest that assumed a layout
 * would delete the wrong directory the first time an engine chose a different one. So the manifest
 * records the **paths that were written**, and revocation removes exactly those that are no longer
 * granted, pruning the directories that become empty. That is strictly more precise than a tree
 * delete — a support file dropped from a skill between two turns of one session is removed even
 * though the skill itself is still assigned.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  RunFileReference,
  RunFileResource,
  RunRequest,
  RunSkillReference,
} from '@agent-workspace/run-protocol';
import {
  skillPlacementVerdict,
  type EngineRunRequest,
  type EngineSkillFile,
  type EngineSkillGrant,
} from '@agent-workspace/engine';
import { normalizeArchivePath } from '@agent-workspace/runtime/transfer';

const MANIFEST = 'agent-workspace-materialized-resources.json';

type MaterializationManifest = {
  readonly files: readonly string[];
  /** The granted skill names, for reporting. */
  readonly skills: readonly string[];
  /** The workspace-relative path of every skill file written. See this module's header. */
  readonly skillFiles: readonly string[];
};

/**
 * The manifest the previous turn left, as read back.
 *
 * `skillFiles` is `null` when the key is absent: the manifest was written by a pre-ENG-04b runner,
 * which recorded only skill *names* against the `<config>/skills/<name>/` layout it wrote. That is
 * a different fact from "no skill file was written", and revocation needs to tell them apart.
 */
type PriorManifest = Omit<MaterializationManifest, 'skillFiles'> & {
  readonly skillFiles: readonly string[] | null;
};

/**
 * What this module needs of an engine, and nothing more.
 *
 * Two members of {@link import('@agent-workspace/engine').AgentEngine}, named structurally rather
 * than taken as the whole port type, so that reading this file tells a reader exactly which engine
 * decisions materialisation depends on: where the engine's own configuration lives, and where its
 * skills go.
 */
export type SkillPlacingEngine = {
  readonly protectedConfigDirectory: string;
  placeSkills(request: EngineRunRequest): readonly EngineSkillFile[];
};

/**
 * Resolve a path that has **already** been through {@link normalizeArchivePath}.
 *
 * Split from {@link within} so that a caller which judges the normalised path (the protected
 * directory guard) writes to exactly the string it judged. `normalizeArchivePath` is not idempotent —
 * it percent-decodes up to three passes — so normalising twice could resolve somewhere else.
 */
function resolveNormalised(root: string, safe: string, original: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, ...safe.split('/'));
  if (!target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`resource path escapes the run workspace: ${JSON.stringify(original)}`);
  }
  return target;
}

function within(root: string, relative: string): string {
  return resolveNormalised(root, normalizeArchivePath(relative), relative);
}

function refuseSymlinkPath(root: string, target: string): void {
  const base = path.resolve(root);
  let current = base;
  for (const segment of path.relative(base, target).split(path.sep)) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`resource materialization refuses symlink path ${JSON.stringify(current)}`);
    }
  }
}

/**
 * Restore write permission on a subtree before removing it.
 *
 * A read-only grant is materialized as `0o555` directories and `0o444` files, and POSIX needs
 * write permission *on the containing directory* to unlink anything inside it. Removing such a
 * tree without this pass fails with `EACCES` for every non-root runtime — which is every runtime
 * the Kubernetes driver starts (`runAsNonRoot: true`).
 */
function makeRemovable(target: string): void {
  if (!existsSync(target)) return;
  if (lstatSync(target).isSymbolicLink()) return;
  if (!statSync(target).isDirectory()) {
    chmodSync(target, 0o600);
    return;
  }
  chmodSync(target, 0o700);
  for (const entry of readdirSync(target)) makeRemovable(path.join(target, entry));
}

/** Unlinking an entry needs write permission on every directory above it, not only on itself. */
function makeParentsRemovable(root: string, target: string): void {
  const base = path.resolve(root);
  let current = base;
  if (existsSync(current)) chmodSync(current, 0o700);
  for (const segment of path.relative(base, path.dirname(target)).split(path.sep)) {
    if (segment.length === 0) continue;
    current = path.join(current, segment);
    if (!existsSync(current) || lstatSync(current).isSymbolicLink()) return;
    chmodSync(current, 0o700);
  }
}

/**
 * Remove a materialized resource. The modes restored here are deliberately permissive: every path
 * that is still granted has its access mode re-applied by {@link materializeFiles}'s final pass.
 */
function removeTree(root: string, target: string): void {
  makeParentsRemovable(root, target);
  makeRemovable(target);
  rmSync(target, { force: true, recursive: true });
}

/**
 * Remove a revoked path, except what is still granted beneath it: a revoked directory that holds a
 * current path (a folder grant narrowed to one of its files) keeps that path and loses the rest.
 */
function removeAllButCurrent(
  root: string,
  target: string,
  relative: string,
  currentFiles: ReadonlySet<string>,
): void {
  const holdsCurrent = [...currentFiles].some((current) => current.startsWith(`${relative}/`));
  if (
    !holdsCurrent ||
    !existsSync(target) ||
    lstatSync(target).isSymbolicLink() ||
    !statSync(target).isDirectory()
  ) {
    removeTree(root, target);
    return;
  }
  makeParentsRemovable(root, target);
  chmodSync(target, 0o700);
  for (const name of readdirSync(target)) {
    const child = `${relative}/${name}`;
    if (currentFiles.has(child)) continue;
    removeAllButCurrent(root, path.join(target, name), child, currentFiles);
  }
}

/** Remove the now-empty directories a deleted skill file left behind, stopping at `stopAt`. */
function pruneEmptyDirectories(root: string, target: string, stopAt: string): void {
  const boundary = path.resolve(stopAt);
  let current = path.dirname(target);
  while (current.startsWith(`${boundary}${path.sep}`)) {
    if (!existsSync(current) || lstatSync(current).isSymbolicLink()) return;
    chmodSync(current, 0o700);
    if (readdirSync(current).length > 0) return;
    makeParentsRemovable(root, current);
    // `recursive` is safe and necessary: the directory was just observed empty, and `rm` without it
    // answers `EISDIR` for a directory rather than removing it.
    rmSync(current, { force: true, recursive: true });
    current = path.dirname(current);
  }
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function readManifest(configDir: string): PriorManifest {
  const manifestPath = path.join(configDir, MANIFEST);
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return { files: [], skills: [], skillFiles: [] };
    }
    const record = parsed as Record<string, unknown>;
    return {
      files: stringList(record['files']),
      skills: stringList(record['skills']),
      skillFiles: 'skillFiles' in record ? stringList(record['skillFiles']) : null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { files: [], skills: [], skillFiles: [] };
    }
    throw new Error(
      `the prior resource manifest could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function removeRevoked(
  request: ResolvedRunRequest,
  configDir: string,
  previous: PriorManifest,
  currentFiles: ReadonlySet<string>,
  currentSkillFiles: ReadonlySet<string>,
): void {
  for (const relative of [...previous.files].sort((a, b) => b.length - a.length)) {
    if (currentFiles.has(relative)) continue;
    const target = within(request.cwd, relative);
    refuseSymlinkPath(request.cwd, target);
    removeAllButCurrent(request.cwd, target, relative, currentFiles);
  }
  if (previous.skillFiles === null) {
    // A pre-ENG-04b manifest: remove every tree the old layout wrote. Without this, the first turn
    // after the upgrade leaves a revoked skill's bytes behind for good — they are in no manifest
    // this runner will ever read — and ADR-0072 D4's "revoked resources are removed" fails exactly
    // at the release boundary. Wholesale is safe: every still-granted file is rewritten from the
    // engine's placements immediately afterwards.
    const skillsRoot = path.join(configDir, 'skills');
    for (const name of previous.skills) {
      const target = within(skillsRoot, name);
      refuseSymlinkPath(skillsRoot, target);
      removeTree(skillsRoot, target);
    }
    return;
  }
  for (const relative of [...previous.skillFiles].sort((a, b) => b.length - a.length)) {
    if (currentSkillFiles.has(relative)) continue;
    const target = within(request.cwd, relative);
    refuseSymlinkPath(request.cwd, target);
    removeTree(request.cwd, target);
    pruneEmptyDirectories(request.cwd, target, configDir);
  }
}

function ensureWritableParents(root: string, target: string): void {
  const base = path.resolve(root);
  let current = base;
  for (const segment of path.relative(base, path.dirname(target)).split(path.sep)) {
    if (segment.length === 0) continue;
    current = path.join(current, segment);
    if (existsSync(current)) chmodSync(current, 0o755);
    else mkdirSync(current, { mode: 0o755 });
  }
}

/**
 * Resolve one granted file's path inside `cwd`, the one way both the writer and the reference
 * verifier (`./verify-files.ts`) do it. Throws for a path outside `cwd`, through a symlink, or under
 * the engine's protected configuration directory — before the caller opens anything there.
 */
export function resolveGrantedPath(
  cwd: string,
  relative: string,
  protectedConfigDirectory: string,
): string {
  // Normalised **once**, and the guard judges the very string the writer then resolves: a guard
  // on any other normalisation can be walked around by a spelling only the writer folds —
  // `.claude\settings.json` and `%2Eclaude/settings.json` both land in `<cwd>/.claude/`.
  // `normalizeArchivePath` throws for everything the writer would refuse (`..`, absolute, malformed
  // encoding) and strips `./` and a trailing `/`. Compared case-insensitively, and ignoring the
  // trailing dots and spaces Windows drops from a name, because `.ClAuDe` and `.claude.` are the
  // same directory there and the engine reads whatever the filesystem hands it.
  const safe = normalizeArchivePath(relative);
  const first = safe.split('/', 1)[0] ?? '';
  if (
    first.replace(/[. ]+$/u, '').toLowerCase() ===
    protectedConfigDirectory.replace(/[. ]+$/u, '').toLowerCase()
  ) {
    throw new Error(
      `assigned file ${JSON.stringify(relative)} targets the private ${protectedConfigDirectory} directory`,
    );
  }
  const target = resolveNormalised(cwd, safe, relative);
  refuseSymlinkPath(cwd, target);
  return target;
}

/** Where `POST /files` places the files of a skill granted by reference (the storage design, §04). */
const SKILL_INBOX = '.aw-inbox';

const skillInboxPath = (name: string, file: string): string =>
  `${SKILL_INBOX}/skills/${name}/${file}`;

/** Each skill file reference as the file reference the verifier checks, under the inbox. */
// @story US-STO-06
export function skillInboxReferences(skills: readonly RunSkillReference[]): RunFileReference[] {
  return skills.flatMap((skill) =>
    skill.files.map((file) => ({
      kind: 'file' as const,
      path: skillInboxPath(skill.name, file.path),
      access: 'read' as const,
      size: file.size,
      sha256: file.sha256,
    })),
  );
}

/**
 * A `/run` request once its skill references have been read from the inbox: the skills carry their
 * bytes so the engine port and {@link materializeSkills} can place them. The bytes never travel
 * on the wire; the wire schema (`RunRequest`) names skill files by reference only.
 */
export type ResolvedRunRequest = Omit<RunRequest, 'resources'> & {
  readonly resources?: {
    readonly files: readonly RunFileResource[];
    readonly skills: readonly EngineSkillGrant[];
  };
};

/** A request that grants no skills, as a {@link ResolvedRunRequest} (there is no inbox to read). */
export function withoutSkills(request: RunRequest): ResolvedRunRequest {
  const { resources, ...rest } = request;
  if (resources === undefined) return rest;
  if (resources.skills.length > 0) {
    throw new Error('withoutSkills: the request grants skills; read the inbox');
  }
  return { ...rest, resources: { files: resources.files, skills: [] } };
}

/**
 * Replace every skill reference with the verified bytes from the inbox, so the engine port and
 * {@link materializeSkills} receive the content (in the sandbox only).
 */
// @story US-STO-06
// @story US-STO-11
export async function readSkillInbox(
  request: RunRequest,
  protectedConfigDirectory: string,
): Promise<ResolvedRunRequest> {
  const resources = request.resources;
  if (resources === undefined) return withoutSkills(request);
  const readInbox = async (name: string, file: string): Promise<string> =>
    (
      await readFile(
        resolveGrantedPath(request.cwd, skillInboxPath(name, file), protectedConfigDirectory),
      )
    ).toString('base64');
  return {
    ...request,
    resources: {
      ...resources,
      skills: await Promise.all(
        resources.skills.map(async (skill) => ({
          name: skill.name,
          files: await Promise.all(
            skill.files.map(async (file) => ({
              path: file.path,
              contentBase64: await readInbox(skill.name, file.path),
            })),
          ),
        })),
      ),
    },
  };
}

/** Remove the inbox, so no agent ever sees it; the bytes it held are already in memory. */
export function removeSkillInbox(cwd: string, protectedConfigDirectory: string): void {
  removeTree(cwd, resolveGrantedPath(cwd, SKILL_INBOX, protectedConfigDirectory));
}

function materializeFiles(
  request: ResolvedRunRequest,
  protectedConfigDirectory: string,
): readonly string[] {
  const resources = request.resources?.files ?? [];
  for (const resource of resources) {
    const target = resolveGrantedPath(request.cwd, resource.path, protectedConfigDirectory);
    ensureWritableParents(request.cwd, target);
    // A file has no bytes to write: they arrived through `POST /files` and were verified before
    // this point; only the guards above and the mode pass below apply.
    if (resource.kind === 'directory') mkdirSync(target, { recursive: true, mode: 0o755 });
  }

  // @story US-STO-06
  // Apply restrictive modes only after every descendant has been created.
  for (const resource of [...resources].sort((a, b) => b.path.length - a.path.length)) {
    const target = within(request.cwd, resource.path);
    chmodSync(
      target,
      resource.access === 'read'
        ? resource.kind === 'directory'
          ? 0o555
          : 0o444
        : resource.kind === 'directory'
          ? 0o755
          : 0o644,
    );
  }
  return resources.map((resource) => resource.path);
}

/**
 * Write every granted skill where the **engine** says it reads them from.
 *
 * The verdict is taken before a byte is written, and it is a throw rather than a skip: a placement
 * outside the engine's own configuration directory is tenant-supplied content landing somewhere the
 * platform never agreed to, and materialising the rest of it "as far as possible" would start a run
 * whose skill surface nobody chose (ADR-0015's explicit `else`).
 */
function materializeSkills(
  request: ResolvedRunRequest,
  placements: readonly EngineSkillFile[],
  paths: readonly string[],
  configDir: string,
): readonly string[] {
  if (placements.length === 0) return [];
  mkdirSync(configDir, { recursive: true });
  const boundary = `${path.resolve(configDir)}${path.sep}`;
  const directories = new Set<string>();
  // `paths[index]` is `placements[index]`'s path, normalised: `skillPlacementVerdict` returns them
  // in the adapter's own order and refuses a list with two placements on one path, so the pairing is
  // total and there is nothing to look up by name.
  for (const [index, placement] of placements.entries()) {
    const relative = paths[index] ?? placement.path;
    const target = within(request.cwd, relative);
    refuseSymlinkPath(request.cwd, target);
    // A changed skill must not leave a removed support file executable or readable on resume, and
    // the previous turn left this tree read-only — so the modes are restored before the rewrite.
    if (existsSync(target)) removeTree(request.cwd, target);
    ensureWritableParents(request.cwd, target);
    let directory = path.dirname(target);
    while (directory.startsWith(boundary)) {
      directories.add(directory);
      directory = path.dirname(directory);
    }
    writeFileSync(target, Buffer.from(placement.contentBase64, 'base64'), { mode: 0o444 });
    chmodSync(target, 0o444);
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    chmodSync(directory, 0o555);
  }
  return paths;
}

/**
 * Materialize the request's explicit allow-list and remove resources revoked since the last turn.
 *
 * `engine` is the adapter this run is addressed to, supplying the two engine-specific answers this
 * function needs (see {@link SkillPlacingEngine}). `engineRequest` is the same run as the port sees
 * it; both are passed because the *bytes* of a granted file are on the contract's request and the
 * port deliberately does not carry them.
 */
export function materializeRunResources(
  request: ResolvedRunRequest,
  engineRequest: EngineRunRequest,
  engine: SkillPlacingEngine,
): MaterializationManifest {
  const configDir = path.join(request.cwd, engine.protectedConfigDirectory);
  mkdirSync(request.cwd, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  // The engine's answer is obtained and checked **before** anything is removed or written: a
  // placement this runner will not write must not leave the sandbox half-rebuilt.
  const placements = engine.placeSkills(engineRequest);
  const placement = skillPlacementVerdict(
    placements,
    engineRequest.resources.skills,
    engine.protectedConfigDirectory,
  );
  if (!placement.ok) {
    throw new Error(
      `engine ${JSON.stringify(engineRequest.engine)} placed a skill file this runner will not write (${placement.refusal}): ${placement.reason}`,
    );
  }

  const previous = readManifest(configDir);
  const currentFiles = new Set((request.resources?.files ?? []).map((file) => file.path));
  removeRevoked(request, configDir, previous, currentFiles, new Set(placement.paths));
  const manifest: MaterializationManifest = {
    files: materializeFiles(request, engine.protectedConfigDirectory),
    skills: (request.resources?.skills ?? []).map((skill) => skill.name),
    skillFiles: materializeSkills(request, placements, placement.paths, configDir),
  };
  const manifestPath = path.join(configDir, MANIFEST);
  const temporary = `${manifestPath}.${request.runId}.tmp`;
  writeFileSync(temporary, JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, manifestPath);
  return manifest;
}
