import { z } from 'zod';

import { ENGINE_IDS } from '@indx-workspace/contracts/engines';
import { NAME_KEY_PATTERN } from '@indx-workspace/contracts/project-file';

import { DefinitionError } from '../define/index.js';
import { ProjectRenderError, type ProjectRenderIssue } from './errors.js';

/** The project name `projectNameFor` falls back to when a directory name has nothing usable. */
const FALLBACK_PROJECT_NAME = 'agent-workspace';

/** The longest project name, in characters (the name-key grammar's limit). */
const PROJECT_NAME_MAX_LENGTH = 64;

const ProjectNameSchema = z
  .string()
  .regex(NAME_KEY_PATTERN, 'must be lower-case kebab, 1-64 characters');

/** A semver numeric identifier: `0`, or digits with no leading zero. */
const NUMERIC_IDENTIFIER = String.raw`(?:0|[1-9]\d*)`;

/** A semver pre-release identifier: numeric with no leading zero, or one with a letter or `-`. */
const PRERELEASE_IDENTIFIER = String.raw`(?:${NUMERIC_IDENTIFIER}|\d*[A-Za-z-][0-9A-Za-z-]*)`;

/** semver.org's grammar for a version with an optional pre-release and no build metadata. */
const EXACT_VERSION_PATTERN = new RegExp(
  String.raw`^${NUMERIC_IDENTIFIER}\.${NUMERIC_IDENTIFIER}\.${NUMERIC_IDENTIFIER}` +
    String.raw`(?:-${PRERELEASE_IDENTIFIER}(?:\.${PRERELEASE_IDENTIFIER})*)?$`,
  'u',
);

/** An exact semver version: the starter project pins the packages to it, never a range. */
const ExactVersionSchema = z
  .string()
  .regex(EXACT_VERSION_PATTERN, { message: 'must be an exact version such as 1.2.3', abort: true })
  .refine((version) => {
    const [core = ''] = version.split('-', 1);
    return core.split('.').every((part) => Number.isSafeInteger(Number(part)));
  }, 'must have major, minor and patch numbers no larger than 2^53 - 1');

/** The project argument of `renderProjectFiles`. */
export const ProjectSchema = z.strictObject({
  name: ProjectNameSchema,
  version: ExactVersionSchema.optional(),
});

/** The project argument of `renderProjectShell`. */
export const ProjectShellSchema = z.strictObject({
  name: ProjectNameSchema,
  version: ExactVersionSchema,
  engine: z.enum(ENGINE_IDS),
});

function issuesFrom(error: z.ZodError): readonly ProjectRenderIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

export function parsed<T>(schema: z.ZodType<T>, value: unknown, subject: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProjectRenderError(subject, issuesFrom(result.error));
  return result.data;
}

/** Runs a `define*` call, turning its refusal into the renderer's own error. */
export function defined<T>(subject: string, define: () => T): T {
  try {
    return define();
  } catch (error) {
    if (error instanceof DefinitionError) throw new ProjectRenderError(subject, error.issues);
    throw error;
  }
}

/**
 * The project name for a directory: lower-cased, every run of characters outside `[a-z0-9]`
 * collapsed to one `-`, hyphens trimmed from both ends, cut to 64 characters and trimmed again;
 * `agent-workspace` when nothing is left. `aw init` (the current directory's name) and
 * `create <dir>` share it, so the same directory always gets the same name. The result always
 * matches the name-key grammar.
 */
export function projectNameFor(directoryName: string): string {
  const input: unknown = directoryName;
  if (typeof input !== 'string') {
    throw new ProjectRenderError('the directory name', [
      { path: '(root)', message: 'must be text' },
    ]);
  }
  const trim = (value: string): string => value.replace(/^-+|-+$/gu, '');
  const name = trim(
    trim(input.toLowerCase().replace(/[^a-z0-9]+/gu, '-')).slice(0, PROJECT_NAME_MAX_LENGTH),
  );
  return name === '' ? FALLBACK_PROJECT_NAME : name;
}
