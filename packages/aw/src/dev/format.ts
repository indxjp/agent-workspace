import { styleText } from 'node:util';

import type { PushedAgent, SkillSync } from '../project/index.js';

/**
 * What `aw dev` prints about one sync (issue #453): pure builders, so the exact lines are tested
 * without a watcher, a loader or a server.
 */

function changeCount(count: number): string {
  return `${String(count)} change${count === 1 ? '' : 's'}`;
}

/** One agent's part of the `synced:` line. */
function syncedPart(agent: PushedAgent): string {
  const name = `"${agent.name}"`;
  const version = String(agent.version);
  switch (agent.action) {
    case 'create':
      return `${name} created at version ${version}`;
    case 'version':
      return `${name} version ${version} (${changeCount(agent.changes.length)})`;
    case 'point':
      // `aw dev` refuses an agent edited outside `aw` (issue #546), so a sync points `local` only
      // from another version to the newest one, which already holds this body.
      return `${name} back on version ${version}`;
    case 'none':
      return `${name} unchanged at version ${version}`;
    default: {
      const unreachable: never = agent.action;
      throw new Error(`unknown push action ${String(unreachable)}`);
    }
  }
}

/** `synced: "assistant" version 3 (1 change), "helper" unchanged at version 1`. */
export function syncSummary(agents: readonly PushedAgent[], skills?: SkillSync): string {
  const changed = (skills?.skills ?? []).filter(({ action }) => action !== 'unchanged');
  const parts = changed.map(
    ({ name, action, files }) =>
      `skill ${name} (${action === 'create' ? 'new' : 'updated'}, ${String(files)} file${files === 1 ? '' : 's'})`,
  );
  if (agents.length > 0) parts.push(agents.map(syncedPart).join(', '));
  return `synced: ${parts.join(' · ')}`;
}

function surfacePage(origin: string, name: string): string {
  return `${origin}/p/s/${encodeURIComponent(name)}`;
}

/** The chat page of surface `name`: what the ready screen's `try` row and the open offer use. */
export function tryPage(origin: string, name: string): string {
  return `${surfacePage(origin, name)}/try`;
}

/**
 * C5: the hosted page, its try page and the one-tag widget snippet of surface `name`, served by
 * the runtime at `origin`. The name is encoded as the web app's own surface links encode it.
 */
export function surfaceLines(origin: string, name: string): readonly string[] {
  const page = surfacePage(origin, name);
  return [
    `page: ${page}`,
    `try: ${page}/try`,
    `widget: <script src="${page}/widget.js" async></script>`,
  ];
}

/**
 * Everything the ready screen says (issue #692). A later line is one more field here and one more
 * row in {@link readyScreen}; nothing else changes.
 */
export interface DevStatus {
  readonly project: string;
  readonly environment: string;
  readonly runtime: { readonly seconds: number; readonly logPath: string };
  /** `admin@example.com (workspace local)`. */
  readonly identity: string;
  /** `anthropic · claude-sonnet-4-5 · key checked`. */
  readonly model: string;
  /** A second line under {@link model}, so the row fits 80 columns (BH061-070). */
  readonly modelNote?: string;
  /**
   * Set when the model cannot be used (issue #690): what is wrong, then the exact fix. The model
   * row is then a `✗` row with these lines instead of {@link model}.
   */
  readonly modelProblem?: readonly string[];
  readonly agents: readonly { readonly name: string; readonly file: string }[];
  readonly surfaces: readonly string[];
  readonly origin: string;
  /**
   * How to sign in to the local web console at {@link origin}: the email, and where the first-run
   * password is (a file path or a variable name, never the password itself).
   */
  readonly console: { readonly email: string; readonly password: string };
  /** Set when the web port moved: `{ port: 3001, wanted: 3000 }`. */
  readonly moved?: { readonly port: number; readonly wanted: number };
  /** Eval cases under `evals/`; the `evals` row is omitted when unset. */
  readonly evalCases?: number;
  /** The project directories `aw dev` syncs on save. */
  readonly watching: readonly string[];
}

/** `plain` drops colour and symbols (`NO_COLOR`, or output that is not a terminal). */
export interface ScreenStyle {
  readonly plain: boolean;
}

/** The ready screen: pure, so the exact text is snapshot-tested. */
export function readyScreen(status: DevStatus, style: ScreenStyle): string {
  const paint = (format: Parameters<typeof styleText>[0], text: string): string =>
    style.plain ? text : styleText(format, text, { validateStream: false });
  const done = (label: string, text: string): string =>
    `  ${style.plain ? ' ' : paint('green', '✓')} ${label.padEnd(9)} ${text}`;
  const failed = (label: string, [first = '', ...rest]: readonly string[]): readonly string[] => [
    `  ${style.plain ? 'x' : paint('red', '✗')} ${label.padEnd(9)} ${first}`,
    ...rest.map((line) => `${' '.repeat(14)}${line}`),
  ];
  const plainRow = (label: string, text: string): string => `  ${label.padEnd(10)}${text}`;

  const { runtime } = status;
  const first = status.surfaces[0];
  const page = first === undefined ? undefined : surfacePage(status.origin, first);
  // What a new user does next comes first: the chat page, the console, the terminal chat.
  const lines = [
    '',
    `  ${paint('bold', 'Agent Workspace')} · ${status.project} · ${status.environment}`,
    '',
    ...(page === undefined ? [] : [plainRow('try', paint('bold', `${page}/try`))]),
    // One fact per line: the three on one row ran past 80 columns and wrapped mid-word (BH061-070).
    plainRow('console', status.origin),
    plainRow('', `sign in as ${status.console.email}`),
    plainRow('', `password in ${status.console.password}`),
    plainRow('chat', 'npx aw chat'),
    '',
    done('runtime', `ready in ${runtime.seconds.toFixed(1)} s   logs: ${runtime.logPath}`),
    ...(status.moved === undefined
      ? []
      : [
          done('web', `on :${String(status.moved.port)} (${String(status.moved.wanted)} was busy)`),
        ]),
    ...(status.modelProblem === undefined
      ? [
          done('model', status.model),
          ...(status.modelNote === undefined ? [] : [`${' '.repeat(14)}${status.modelNote}`]),
        ]
      : failed('model', status.modelProblem)),
    done('signed in', `as ${status.identity}`),
    ...status.agents.map(({ name, file }) => done('agent', `${name}  (${file})`)),
    ...status.surfaces.map((name) => done('surface', name)),
    '',
    ...(status.evalCases === undefined
      ? []
      : [
          plainRow(
            'evals',
            `${String(status.evalCases)} case${status.evalCases === 1 ? '' : 's'} · npx aw eval`,
          ),
        ]),
  ];
  if (page !== undefined) {
    lines.push(
      plainRow('embed', `<script src="${page}/widget.js" async></script>`),
      plainRow('react', 'https://docs.agentworkspace.indx.jp/building/react'),
    );
  }
  lines.push(
    '',
    paint('dim', `  watching ${status.watching.join(' ')} · edit a file and save`),
    '',
  );
  return lines.join('\n');
}
