/**
 * Never wider than the creator (design §04 "Agents that build agents", #1851): where a draft built
 * by an agent gives the new agent more than the creating agent has. Pure, and separate from the
 * deployment's policy ceiling (`enforceCeiling`): that asks "wider than the deployment allows",
 * this asks "wider than this creator". Both must pass.
 */
import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import { AGENT_PERMISSION_KEYS, policyNarrowedPermissions } from '@indx-workspace/contracts/agents';
import { isCanonicalFileScopePath } from '@indx-workspace/contracts/runs';

/** One place a child asks for more than its creator has. */
export interface Widening {
  readonly path: string;
  readonly child: unknown;
  readonly creator: unknown;
}

/**
 * How `widenings` treats each part of an `AgentVersionBody`: `rule` has its own comparison below,
 * `identity` is never compared, and `failClosed` must equal the creator's. A key this table does
 * not name is compared too, so a field added later cannot widen silently; the test that walks the
 * schema, element shapes of `files[]` and `subagents[]` included (`<list>[].<key>`), fails until
 * it is classified here.
 */
export const FIELD_CLASSES: Readonly<Record<string, 'rule' | 'identity' | 'failClosed'>> = {
  'definition.apiVersion': 'failClosed',
  'definition.kind': 'failClosed',
  'definition.policySource': 'failClosed',
  'definition.agent.name': 'identity',
  'definition.agent.instructions': 'identity',
  'definition.agent.permissions': 'rule',
  'definition.agent.model': 'rule',
  'definition.agent.modelConnectionName': 'failClosed',
  'definition.agent.runtimeProfileName': 'failClosed',
  'definition.policy.engine': 'rule',
  'definition.policy.skills': 'rule',
  'definition.policy.limits.maxTurns': 'rule',
  'definition.policy.limits.maxBudgetUsd': 'rule',
  'definition.policy.withheldPermissions': 'rule',
  'definition.policy.tools': 'failClosed',
  'definition.policy.requireApproval': 'failClosed',
  'definition.policy.handoff': 'failClosed',
  'definition.policy.reasoningEffort': 'failClosed',
  'definition.policy.parallelToolCalls': 'failClosed',
  'definition.policy.thinkingLevel': 'failClosed',
  'definition.policy.toolCallConcurrency': 'failClosed',
  'definition.resources.files': 'rule',
  'definition.resources.files[].path': 'rule',
  'definition.resources.files[].access': 'rule',
  'definition.resources.skills': 'rule',
  'definition.resources.skillRevisions': 'rule',
  'definition.resources.connectors': 'rule',
  surfaces: 'failClosed',
  toolBundles: 'failClosed',
  description: 'identity',
  subagents: 'rule',
  'subagents[].name': 'rule',
  knowledge: 'failClosed',
};

const ACCESS_NAMES = ['none', 'read', 'read-write'] as const;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, i) => isDeepEqual(item, right[i]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) =>
      isDeepEqual(left[key], right[key]),
    );
  }
  return false;
}

/** Each name `child` has and `creator` lacks, as a widening at `base[<name>]`. */
function missingFrom(
  base: string,
  child: readonly string[],
  creator: readonly string[],
): Widening[] {
  const creatorHas = new Set(creator);
  return [...new Set(child)]
    .filter((name) => !creatorHas.has(name))
    .map((name) => ({ path: `${base}[${JSON.stringify(name)}]`, child: true, creator: false }));
}

/** The skills a run composes: the assigned ones, cut to the policy's allowlist when it has one. */
function effectiveSkills(body: AgentVersionBody): readonly string[] {
  const { resources, policy } = body.definition;
  const allowed = policy.skills;
  return allowed.mode === 'all'
    ? resources.skills
    : resources.skills.filter((name) => allowed.names.includes(name));
}

type FileGrant = AgentVersionBody['definition']['resources']['files'][number];

/** How much a grant gives: 1 read, 2 read-write. An access added later fails to compile here. */
function rank(access: FileGrant['access']): number {
  switch (access) {
    case 'read':
      return 1;
    case 'read-write':
      return 2;
    default: {
      const unreachable: never = access;
      return unreachable;
    }
  }
}

/**
 * The most specific grant covering `path`: its own path (what a widening is reported at) and the
 * access it gives, 0 for none, 1 read, 2 read-write.
 */
function accessAt(
  files: AgentVersionBody['definition']['resources']['files'],
  path: string,
): { readonly grantPath: string | null; readonly access: number } {
  let grantPath: string | null = null;
  let access = 0;
  for (const grant of files) {
    const covers =
      path === grant.path ||
      (path.startsWith(`${grant.path}/`) &&
        isCanonicalFileScopePath(path.slice(grant.path.length + 1)));
    if (!covers) continue;
    if (grantPath === null || grant.path.length > grantPath.length) {
      grantPath = grant.path;
      access = rank(grant.access);
    } else if (grant.path.length === grantPath.length) {
      access = Math.max(access, rank(grant.access));
    }
  }
  return { grantPath, access };
}

const exceeds = (child: number | null, creator: number | null): boolean =>
  creator !== null && (child === null || child > creator);

/**
 * Removing these is narrowing. Not `toolBundles`: an agent with none is not sandboxed and gets the
 * dev-tools connector unpinned, so any bundle difference fails closed.
 */
const REMOVABLE = new Set(['surfaces', 'knowledge']);

const isEmptyOrAbsent = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.length === 0);

/**
 * Fail-closed default inside `files[]` and `subagents[]` elements: a key beyond `known` that the
 * creator's element with the same `idKey` lacks (or has with another value) is a widening there.
 */
function extraKeysWiden(
  base: string,
  child: readonly object[],
  creator: readonly object[],
  idKey: string,
  known: readonly string[],
): Widening[] {
  const extras = (element: object): Record<string, unknown> =>
    Object.fromEntries(Object.entries(element).filter(([key]) => !known.includes(key)));
  const idOf = (element: object): unknown => (element as Record<string, unknown>)[idKey];
  return child.flatMap((element) => {
    const mine = extras(element);
    const theirs = creator.filter((other) => idOf(other) === idOf(element)).map(extras);
    return Object.keys(mine).length > 0 && !theirs.some((other) => isDeepEqual(mine, other))
      ? [{ path: `${base}[${JSON.stringify(idOf(element))}]`, child: mine, creator: theirs[0] }]
      : [];
  });
}

/** Anything outside `FIELD_CLASSES`'s rules that differs from the creator's, at its key path. */
function differing(child: unknown, creator: unknown, path: string, out: Widening[]): void {
  const kind = FIELD_CLASSES[path];
  if (kind === 'rule' || kind === 'identity') return;
  if (REMOVABLE.has(path) && isEmptyOrAbsent(child)) return;
  if (isPlainObject(child) && isPlainObject(creator)) {
    for (const key of new Set([...Object.keys(child), ...Object.keys(creator)])) {
      differing(child[key], creator[key], path === '' ? key : `${path}.${key}`, out);
    }
  } else if (!isDeepEqual(child, creator)) {
    out.push({ path, child, creator });
  }
}

/**
 * Where `child` has more than `creator`, sorted by path. A child is not wider when its permissions,
 * connectors, skills (and their pins), file grants (same or narrower path, same or lower access),
 * limits (`null` is unlimited), and subagents are all within the creator's, and its engine and model
 * are the creator's. Everything else must equal the creator's, except that a child with no
 * `surfaces` or `knowledge` is narrower; see {@link FIELD_CLASSES}.
 */
export function widenings(child: AgentVersionBody, creator: AgentVersionBody): readonly Widening[] {
  const found: Widening[] = [];
  const c = child.definition;
  const p = creator.definition;

  const childPermissions = policyNarrowedPermissions(c.agent.permissions, c.policy);
  const creatorPermissions = policyNarrowedPermissions(p.agent.permissions, p.policy);
  for (const key of AGENT_PERMISSION_KEYS) {
    if (childPermissions[key] && !creatorPermissions[key]) {
      found.push({ path: `definition.agent.permissions.${key}`, child: true, creator: false });
    }
  }

  found.push(
    ...missingFrom(
      'definition.resources.connectors',
      c.resources.connectors,
      p.resources.connectors,
    ),
    ...missingFrom(
      'subagents',
      (child.subagents ?? []).map((s) => s.name),
      (creator.subagents ?? []).map((s) => s.name),
    ),
  );

  const childSkills = effectiveSkills(child);
  const creatorSkills = effectiveSkills(creator);
  found.push(...missingFrom('definition.resources.skills', childSkills, creatorSkills));
  for (const name of childSkills.filter((skill) => creatorSkills.includes(skill))) {
    const childPin = c.resources.skillRevisions?.[name] ?? null;
    const creatorPin = p.resources.skillRevisions?.[name] ?? null;
    if (childPin !== creatorPin) {
      found.push({
        path: `definition.resources.skillRevisions[${JSON.stringify(name)}]`,
        child: childPin,
        creator: creatorPin,
      });
    }
  }

  // Every path either body names is checked, and a widening is reported at the child's most
  // specific grant covering it, so a path that exists only in the creator's body never leaks.
  for (const path of new Set(
    [...c.resources.files, ...p.resources.files].map((grant) => grant.path),
  )) {
    const atChild = accessAt(c.resources.files, path);
    const atCreator = accessAt(p.resources.files, path);
    if (atChild.grantPath !== null && atChild.access > atCreator.access) {
      found.push({
        path: `definition.resources.files[${JSON.stringify(atChild.grantPath)}]`,
        child: ACCESS_NAMES[atChild.access],
        creator: ACCESS_NAMES[atCreator.access],
      });
    }
  }
  found.push(
    ...extraKeysWiden('definition.resources.files', c.resources.files, p.resources.files, 'path', [
      'path',
      'access',
    ]),
    ...extraKeysWiden('subagents', child.subagents ?? [], creator.subagents ?? [], 'name', [
      'name',
    ]),
  );

  for (const limit of ['maxTurns', 'maxBudgetUsd'] as const) {
    if (exceeds(c.policy.limits[limit], p.policy.limits[limit])) {
      found.push({
        path: `definition.policy.limits.${limit}`,
        child: c.policy.limits[limit],
        creator: p.policy.limits[limit],
      });
    }
  }

  if (c.policy.engine !== p.policy.engine) {
    found.push({
      path: 'definition.policy.engine',
      child: c.policy.engine,
      creator: p.policy.engine,
    });
  }
  if (c.agent.model !== p.agent.model) {
    found.push({ path: 'definition.agent.model', child: c.agent.model, creator: p.agent.model });
  }

  differing(child, creator, '', found);

  const byPath = new Map<string, Widening>();
  for (const widening of found) if (!byPath.has(widening.path)) byPath.set(widening.path, widening);
  return Object.freeze(
    [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
}
