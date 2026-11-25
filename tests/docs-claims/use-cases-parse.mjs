/**
 * Reading a use-case project's files: the commands its project file comments tell you to run, the
 * eval file's first prompt, and the output of `aw eval` / `aw chat`.
 */
import { JourneyFailure } from '../journey/harness.mjs';

/** A stand-in for a company's HTTP API behind an `openapiTool()`, as opposed to an MCP server. */
export const STAND_IN = /(?:^|\/)fake-[^/]+\.mjs$/u;

const ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=(\S*)\s*/u;
const PLACEHOLDER = /^(?:\.\.\.|…)$/u;

/**
 * The indented `#   ...` lines of a project file: the commands its comments tell you to run.
 *
 * @param {string} projectYaml
 */
const commentCommands = (projectYaml) =>
  projectYaml
    .replace(/ \\\n#\s+/gu, ' ')
    .split('\n')
    .flatMap((line) => {
      const command = /^#\s{3,}(\S.*)$/u.exec(line)?.[1];
      return command === undefined ? [] : [command];
    });

/**
 * @param {string} line a command line that may start with `NAME=value` words
 * @param {() => string} secret a value for the placeholders `...` and `…`
 * @returns {{ env: Record<string, string>, rest: string }}
 */
function leadingEnvironment(line, secret) {
  /** @type {Record<string, string>} */
  const env = {};
  let rest = line;
  for (let match = ASSIGNMENT.exec(rest); match !== null; match = ASSIGNMENT.exec(rest)) {
    env[match[1] ?? ''] = PLACEHOLDER.test(match[2] ?? '') ? secret() : (match[2] ?? '');
    rest = rest.slice(match[0].length);
  }
  return { env, rest };
}

/**
 * The line a project file adds a workspace secret with: `aw dev` holds an Admin key and only an
 * Owner may store a secret (ADR-0109), so the secret is added in the console, in the words `aw dev`'s
 * own notice uses (`add <NAME> under Secrets`).
 */
const SECRET_ADD =
  /\badd ([A-Z][A-Z0-9_]*) under Secrets in the console, signed in as the Owner\b/u;
const IDENTITY_KEY = /(?:^|_)IDENTITY_SECRET$/u;

/**
 * The workspace secrets a project file says to add (`add <NAME> under Secrets in the console, signed
 * in as the Owner`), in its order: the keys that sign a caller assertion (ADR-0142 D1).
 *
 * @param {string} projectYaml
 * @returns {string[]}
 */
export function workspaceSecrets(projectYaml) {
  const names = commentCommands(projectYaml).flatMap((line) => {
    const name = SECRET_ADD.exec(line)?.[1];
    return name === undefined ? [] : [name];
  });
  return [...new Set(names)];
}

/**
 * @typedef {{ key: string, secret: string }} ServerIdentity the variable that holds a server's
 *   verifying key, and the workspace secret whose value it must be
 * @typedef {{ env: Record<string, string>, script: string, port: number, identity?: ServerIdentity }} ServerCommand
 */

/**
 * The MCP servers a project file says to run: `NAME=value ... node <script>.mjs`, with a placeholder
 * value replaced by `secret()` and a variable in `overrides` by its value there.
 *
 * A server that verifies the caller assertion (it is given `IDENTITY_AUDIENCE`) has an `identity`:
 * the variable holding its key (`IDENTITY_SECRET` or `<NAME>_IDENTITY_SECRET`) and the workspace
 * secret that key is. A `<NAME>_IDENTITY_SECRET` is that secret; a bare `IDENTITY_SECRET` is the one
 * the nearest line before the server's line adds, as the project file reads.
 * When `overrides` holds that secret, the key is its value.
 *
 * @param {string} projectYaml @param {() => string} secret
 * @param {Readonly<Record<string, string>>} [overrides]
 * @returns {ServerCommand[]}
 */
export function serverCommands(projectYaml, secret, overrides = {}) {
  /** @type {string | undefined} */
  let created;
  return commentCommands(projectYaml).flatMap((line) => {
    const name = SECRET_ADD.exec(line)?.[1];
    if (name !== undefined) {
      created = name;
      return [];
    }
    const { env, rest } = leadingEnvironment(line, secret);
    const script = /^node (\S+\.mjs)$/u.exec(rest)?.[1];
    if (script === undefined) return [];
    for (const variable of Object.keys(env))
      if (variable in overrides) env[variable] = overrides[variable] ?? '';
    const key = Object.keys(env).find((variable) => IDENTITY_KEY.test(variable));
    const signer = key === 'IDENTITY_SECRET' ? created : key;
    if (!('IDENTITY_AUDIENCE' in env) || key === undefined || signer === undefined) {
      return [{ env, script, port: Number(env['PORT']) }];
    }
    const value = overrides[signer];
    if (value !== undefined) env[key] = value;
    return [{ env, script, port: Number(env['PORT']), identity: { key, secret: signer } }];
  });
}

/**
 * @typedef {{ connectorId: string, workspaceId: string }} IdentityTarget what a caller assertion
 *   for one connector names: its `aud` and its `workspace`
 */

/**
 * The connector each identity secret signs for, from `aw connectors list --json` once `aw push`
 * has registered the project's tools and connectors: a caller assertion's `aud` is that
 * connector's id (an MCP connector's or an `openapiTool()`'s alike) and its `workspace` is the
 * connector's workspace.
 *
 * @param {string} listJson
 * @returns {Map<string, IdentityTarget>}
 */
export function identityTargets(listJson) {
  let parsed;
  try {
    parsed = JSON.parse(listJson);
  } catch {
    throw new JourneyFailure(`aw connectors list --json printed no JSON:\n${listJson}`);
  }
  const connectors = Array.isArray(parsed) ? parsed : parsed?.connectors;
  if (!Array.isArray(connectors)) {
    throw new JourneyFailure(`aw connectors list --json printed no connectors:\n${listJson}`);
  }
  /** @type {Map<string, IdentityTarget>} */
  const targets = new Map();
  for (const connector of connectors) {
    const signer = connector?.identity?.secret;
    if (typeof signer !== 'string') continue;
    if (typeof connector.id !== 'string' || typeof connector.workspaceId !== 'string') continue;
    if (targets.has(signer)) {
      throw new JourneyFailure(`more than one connector signs with ${signer}`);
    }
    targets.set(signer, { connectorId: connector.id, workspaceId: connector.workspaceId });
  }
  return targets;
}

/**
 * The environment a server that verifies the caller assertion is restarted with: the id of the
 * connector its secret signs for and the workspace, in place of the project file's
 * `<tool-id>` / `<connector-id>` and `<workspace-id>`.
 *
 * @param {ServerCommand} server @param {ReadonlyMap<string, IdentityTarget>} targets
 * @returns {Record<string, string>}
 */
export function identityEnvironment(server, targets) {
  if (server.identity === undefined) return server.env;
  const target = targets.get(server.identity.secret);
  if (target === undefined) {
    throw new JourneyFailure(
      `${server.script}: after aw push, no connector signs its caller assertion with ${server.identity.secret}`,
    );
  }
  return {
    ...server.env,
    IDENTITY_AUDIENCE: target.connectorId,
    IDENTITY_WORKSPACE: target.workspaceId,
  };
}

/**
 * The environment a project file says `aw dev` needs: `NAME=value ... aw dev`.
 *
 * @param {string} projectYaml @param {() => string} secret
 * @returns {Record<string, string>}
 */
export function devEnvironment(projectYaml, secret) {
  return Object.assign(
    {},
    ...commentCommands(projectYaml).flatMap((line) => {
      const { env, rest } = leadingEnvironment(line, secret);
      return rest === 'aw dev' ? [env] : [];
    }),
  );
}

/**
 * The `input:` of the first case of an eval file, plain or as a `|` / `>` block.
 *
 * @param {string} evalYaml
 * @returns {string | undefined}
 */
export function firstPrompt(evalYaml) {
  const lines = evalYaml.split('\n');
  const at = lines.findIndex((line) => /^ {4}input:/u.test(line));
  if (at < 0) return undefined;
  const value = (lines[at] ?? '').replace(/^ {4}input:\s*/u, '');
  if (!/^[|>][+-]?$/u.test(value))
    return value.replace(/^(["'])(.*)\1$/u, '$2').trim() || undefined;
  const block = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && !line.startsWith('      ')) break;
    block.push(line.slice(6));
  }
  const text = block.join('\n').trim();
  return text === '' ? undefined : text;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The most runs traced per project: each trace may take `commandMs`, inside the step's budget. */
export const MAX_TRACED_RUNS = 5;

/**
 * The cases of an `aw eval --json` output that failed after a run started, with the run to trace,
 * at most `MAX_TRACED_RUNS` of them (the eval output in the log names every failed case).
 * Output that is not an evaluation (or a list of them) gives none: the caller is already failing.
 * When the whole output is not JSON, it is parsed from the first line that starts with `{` or `[`
 * and parses, so earlier lines (progress notices, even bracketed ones) are ignored.
 *
 * @param {string} evalStdout
 * @returns {{ name: string, runId: string, failures: string[] }[]}
 */
export function failedRuns(evalStdout) {
  const parsed = parseEvalOutput(evalStdout);
  if (parsed === undefined) return [];
  const results = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((evaluation) =>
    Array.isArray(evaluation?.results) ? evaluation.results : [],
  );
  return results.flatMap(failedRunOf).slice(0, MAX_TRACED_RUNS);
}

/** @param {string} text @returns {unknown} the parsed JSON, or undefined when none parses */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** @param {string} evalStdout the whole output, or its first line that starts a JSON document */
function parseEvalOutput(evalStdout) {
  const whole = parseJson(evalStdout);
  if (whole !== undefined) return whole;
  for (const match of evalStdout.matchAll(/^[{[]/gmu)) {
    const candidate = parseJson(evalStdout.slice(match.index));
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

/** @param {any} result one case of an evaluation @returns {{ name: string, runId: string, failures: string[] }[]} */
function failedRunOf(result) {
  if (result?.passed !== false || typeof result.runId !== 'string') return [];
  if (!RUN_ID.test(result.runId)) return [];
  const failures = Array.isArray(result.failures)
    ? result.failures.filter((failure) => typeof failure === 'string')
    : [];
  return [{ name: String(result.name), runId: result.runId, failures }];
}

/**
 * The run a failed `aw chat -p` names (`error: run_failed: run <uuid> failed: …`), for the caller to
 * trace. Undefined when the output names none, or an id that is not a UUID (it is put in a command).
 *
 * @param {string} chatOutput
 * @returns {string | undefined}
 */
export function chatFailedRunId(chatOutput) {
  const id = /\brun (\S+) failed\b/u.exec(chatOutput)?.[1];
  return id !== undefined && RUN_ID.test(id) ? id : undefined;
}

/**
 * The run a `aw chat -p` paused on (`error: run_awaiting_approval: run <uuid> failed: the run ended
 * awaiting_approval`): a use case whose tutorial has a person approve a tool call (cad-drafting's
 * change set, excel-consolidation's workbook). Undefined for any other failure.
 *
 * @param {string} chatOutput
 * @returns {string | undefined}
 */
export function chatPausedRunId(chatOutput) {
  return /\brun_awaiting_approval:/u.test(chatOutput) ? chatFailedRunId(chatOutput) : undefined;
}

/**
 * The run `aw runs approve <id> --json` (`{ run, events }`) or `aw runs wait <id> --json` (the run)
 * prints: its id, status and answer text. Throws when the output is not such a run, or its id is
 * not a UUID (it is put in the next command).
 *
 * @param {string} stdout
 * @returns {{ id: string, status: string, text: string }}
 */
export function printedRun(stdout) {
  const parsed = parseJson(stdout);
  const record = isRecord(parsed) && isRecord(parsed['run']) ? parsed['run'] : parsed;
  if (!isRecord(record) || typeof record['id'] !== 'string' || !RUN_ID.test(record['id'])) {
    throw new Error(`not a run: ${stdout.slice(0, 200)}`);
  }
  const output = isRecord(record['output']) ? record['output'] : {};
  return {
    id: record['id'],
    status: String(record['status']),
    text: typeof output['text'] === 'string' ? output['text'] : '',
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
