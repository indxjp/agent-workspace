import { COMPOSE_PROJECT_NAME_PATTERN, RESERVED_COMPOSE_PROJECT_NAME } from './compose-project.ts';
import { assertDigestReference } from './deployment-images.ts';
import { COMPOSE_PROJECT_CREATE_COMMAND } from './profile.ts';

/** One line of `.env`, split so a writer can replace the value and keep every other byte. */
type EnvLine =
  | { readonly kind: 'blank' }
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'entry';
      /** Indentation and an `export ` keyword, as written; `''` when the line has neither. */
      readonly prefix: string;
      readonly key: string;
      readonly value: string;
      /** What follows the value: trailing whitespace and an inline `# comment`, or `''`. */
      readonly suffix: string;
    };

const ENV_LINE_PREFIX = /^\s*(?:export\s+)?/u;

const INLINE_COMMENT = /\s#/u;

/**
 * Read one `.env` line (without its line ending) the way Compose's dotenv reader reads the forms
 * an operator writes by hand: an optional `export ` before the name, and, in an unquoted value, a
 * `#` after whitespace starting a comment. A quoted value is taken as it stands. Blank lines and
 * `#` comment lines are `blank`; any other line that is not `NAME=value` is `invalid`.
 */
export function parseEnvLine(line: string): EnvLine {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return { kind: 'blank' };
  const prefix = ENV_LINE_PREFIX.exec(line)?.[0] ?? '';
  const rest = line.slice(prefix.length);
  const separator = rest.indexOf('=');
  if (separator < 1) return { kind: 'invalid' };
  const body = rest.slice(separator + 1);
  let value = body.trimEnd();
  if (!value.startsWith('"') && !value.startsWith("'")) {
    const comment = INLINE_COMMENT.exec(value);
    if (comment !== null) value = value.slice(0, comment.index).trimEnd();
  }
  return {
    kind: 'entry',
    prefix,
    key: rest.slice(0, separator),
    value,
    suffix: body.slice(value.length),
  };
}

/**
 * A wholly quoted value as Compose's dotenv reader gives it: `'…'` literally, `"…"` with `\\`,
 * `\"` and `\n` unescaped. Any other value, including a quoted one followed by a `# comment`, is
 * returned as written. `aw deploy` writes `AW_DEPLOYMENT_POLICY` single-quoted, and a deploy that
 * copied the quotes to a host would make the control plane refuse to start on a policy that "is
 * not JSON".
 */
function unquoted(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== "'" && quote !== '"') || value.at(-1) !== quote) return value;
  const inner = value.slice(1, -1);
  if (quote === "'") return inner.includes("'") ? value : inner;
  return inner.replace(/\\([\\"n])/gu, (_match, escaped: string) =>
    escaped === 'n' ? '\n' : escaped,
  );
}

/** The `.env` entries as Compose reads them: quoted values are unquoted, the last duplicate wins. */
export function parseEnvironment(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const [index, rawLine] of contents.split(/\r?\n/u).entries()) {
    const line = parseEnvLine(rawLine);
    if (line.kind === 'blank') continue;
    // By number, never quoted: a malformed line may hold a secret (a mistyped `KEY: value`, a
    // multi-line PEM) and this message reaches the terminal and CI logs.
    if (line.kind === 'invalid') throw new Error(`Invalid .env line ${index + 1}`);
    parsed[line.key] = unquoted(line.value);
  }
  return parsed;
}

/**
 * The object-store pin a generated `.env` carries. `SEAWEEDFS_IMAGE` since ADR-0067; a project
 * generated before it has its own copy of the MinIO-era `compose.yaml` and a `.env` that pins
 * `MINIO_IMAGE` instead, and `start` keeps holding that project to the digest gate rather than
 * refusing it for a variable its Compose file never reads.
 */
function objectStoreImageKey(environment: Record<string, string>): string {
  if (environment['SEAWEEDFS_IMAGE'] === undefined && environment['MINIO_IMAGE'] !== undefined) {
    return 'MINIO_IMAGE';
  }
  return 'SEAWEEDFS_IMAGE';
}

/**
 * `engineImageEnvName('claude-agent-sdk')` of `packages/runtime` (ENG-07, ADR-0073), restated
 * because the published CLI must not import that private package (ADR-0082's amendment for #364);
 * `packages/embedded/src/runtime-pins.test.ts` holds the two equal.
 */
export const CLAUDE_AGENT_SDK_RUNTIME_IMAGE_KEY = 'AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK';

/**
 * The Claude engine's runtime-image pin a generated `.env` carries.
 * `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK` since ENG-07 (ADR-0073); a project generated
 * before it has its own copy of the older `compose.yaml` and a `.env` that pins `RUNTIME_IMAGE`,
 * and `start` keeps holding that project to the digest gate rather than refusing it.
 */
function runtimeImageKey(environment: Record<string, string>): string {
  const current = CLAUDE_AGENT_SDK_RUNTIME_IMAGE_KEY;
  if (environment[current] === undefined && environment['RUNTIME_IMAGE'] !== undefined) {
    return 'RUNTIME_IMAGE';
  }
  return current;
}

/**
 * The longest project name accepted. It is also the session cookie's suffix (`AW_INSTANCE_ID`,
 * issue #394), which the web service keeps to 63 characters; `create` writes at most 48.
 */
const COMPOSE_PROJECT_NAME_MAX_LENGTH = 63;

/**
 * Refuse a `COMPOSE_PROJECT_NAME` that `create` would never have written, before any command acts
 * on it: one Compose rejects or that could widen a Docker `--filter`, one too long to scope the
 * session cookie by, or `agent-workspace`, the repository's development stack, which `stop` would
 * otherwise take down. Returns the name.
 */
export function assertComposeProjectName(value: string | undefined): string {
  const project = value?.trim() ?? '';
  const fix =
    `Set it in .env to the name \`${COMPOSE_PROJECT_CREATE_COMMAND}\` generated: lowercase ` +
    'letters, digits, "-" and "_", starting with a letter or digit, at most ' +
    `${String(COMPOSE_PROJECT_NAME_MAX_LENGTH)} characters. A kind: Project directory runs with ` +
    '`aw dev` instead.';
  if (!COMPOSE_PROJECT_NAME_PATTERN.test(project)) {
    throw new Error(
      `COMPOSE_PROJECT_NAME ${JSON.stringify(project)} is not a Compose project name. ${fix}`,
    );
  }
  if (project.length > COMPOSE_PROJECT_NAME_MAX_LENGTH) {
    throw new Error(
      `COMPOSE_PROJECT_NAME is ${String(project.length)} characters long; it also names the ` +
        `session cookie, so it must be at most ${String(COMPOSE_PROJECT_NAME_MAX_LENGTH)}. ${fix}`,
    );
  }
  if (project === RESERVED_COMPOSE_PROJECT_NAME) {
    throw new Error(
      `COMPOSE_PROJECT_NAME "${RESERVED_COMPOSE_PROJECT_NAME}" is reserved for the repository's own ` +
        'development stack, which this command must never act on. Rename the project in .env.',
    );
  }
  return project;
}

export function validateDeploymentEnvironment(environment: Record<string, string>): void {
  // Absent, Compose itself refuses the generated `compose.yaml` (`${COMPOSE_PROJECT_NAME:?}`).
  if (environment['COMPOSE_PROJECT_NAME'] !== undefined) {
    assertComposeProjectName(environment['COMPOSE_PROJECT_NAME']);
  }
  for (const key of [
    'WEB_IMAGE',
    'GATEWAY_IMAGE',
    'RUNNER_IMAGE',
    runtimeImageKey(environment),
    'POSTGRES_IMAGE',
    objectStoreImageKey(environment),
  ]) {
    assertDigestReference(environment[key] ?? '', key);
  }
  if (environment['RUNTIME_DRIVER'] !== 'docker') {
    throw new Error(
      `Configured runtime ${JSON.stringify(environment['RUNTIME_DRIVER'])} disagrees with generated topology runtime "docker"`,
    );
  }
}
