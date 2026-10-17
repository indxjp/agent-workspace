/**
 * `docs/engine-matrix.md`, rendered from what each adapter declares and what the conformance kit
 * observes (ENG-04, #303).
 *
 * Written next to `tests/driver-matrix/` and for the same reason that exists: a capability table
 * maintained by hand is wrong the day a capability changes, and the usual repair corrects the
 * cell rather than the mechanism that produced the wrong cell.
 *
 * **Every cell is derived, and from two independent places.** The capability rows come from each
 * adapter's own declaration — the value `apps/runner` actually consults — and the conformance
 * row from running `@agent-workspace/engine/testing`'s scenarios against that adapter. A table
 * that read only the declaration would report what an engine *claims*; one that read only the
 * kit would report what it passed without saying what it promised. The interesting failure is a
 * disagreement between the two, and only a table with both can show one.
 *
 * The renderer is a module rather than a script so that it can import the packages' TypeScript
 * directly: `tests/engine-matrix.test.ts` is the gate that compares its output to the committed
 * file, and `tests/engine-matrix/run.mjs` is the `pnpm docs:generate` entry that rewrites it.
 */
import { ENGINE_CAPABILITY_KEYS } from '@indx-workspace/contracts/engines';
import type { EngineCapabilities } from '@indx-workspace/contracts/engines';
import type { AgentEngine } from '@agent-workspace/engine';
import {
  CONFORMANCE_SCENARIOS,
  createScriptedGateway,
  type EngineConformanceSubject,
} from '@agent-workspace/engine/testing';
import {
  CLAUDE_AGENT_SDK_ENGINE_ADAPTER,
  CLAUDE_AGENT_SDK_ENGINE_ID,
  claudeGatewayEnv,
  claudeOptionsAllowPermission,
  claudeOptionsAllowWrite,
  type CompiledSdkOptions,
} from '@agent-workspace/engine-claude-agent-sdk';
import {
  MASTRA_ENGINE_ADAPTER,
  MASTRA_ENGINE_ID,
  mastraPlanAllowsPermission,
  mastraWriteAllowed,
  type MastraCompiled,
} from '@agent-workspace/engine-mastra';
import {
  OPENAI_AGENTS_ENGINE_ADAPTER,
  OPENAI_AGENTS_ENGINE_ID,
  openAiAgentsPlanAllowsPermission,
  workspaceWriteAllowed,
  type OpenAiAgentsCompiled,
} from '@agent-workspace/engine-openai-agents';
import {
  PI_ENGINE_ADAPTER,
  PI_ENGINE_ID,
  piPlanAllowsPermission,
  workspaceWriteAllowed as piWorkspaceWriteAllowed,
  type PiCompiled,
} from '@agent-workspace/engine-pi';

/** One boolean capability the matrix shows, with the human name it shows it under. */
type CapabilityRow = {
  readonly key: keyof EngineCapabilities;
  readonly label: string;
};

/**
 * The boolean rows, in the order a reader meets them: what an engine can be *asked* for.
 *
 * The three non-boolean keys — `maxTurns`, `maxBudget`, `wireProtocols` — get rows of their own
 * below, because they carry a value rather than a tick.
 */
const CAPABILITY_ROWS: readonly CapabilityRow[] = [
  { key: 'mcp', label: 'MCP connectors' },
  { key: 'skills', label: 'Skills' },
  { key: 'subagents', label: 'Subagents' },
  { key: 'resume', label: 'Resume a session' },
  { key: 'fork', label: 'Fork a session' },
  { key: 'interrupt', label: 'Interrupt a turn' },
  { key: 'streamingText', label: 'Streaming text' },
  { key: 'reasoning', label: 'Reasoning reported' },
];

/**
 * The scenarios this renderer can run: the ones that stop at `compile`.
 *
 * An adapter's `start` spawns its engine and needs a credential, so a generator that claimed a
 * PASS on the run scenarios would be reporting something it did not observe — the shape ADR-0015
 * exists to refuse. The whole kit runs against recorded engine messages in each adapter's own
 * test file, and the matrix says so in its own prose rather than leaving the number unexplained.
 */
const COMPILE_ONLY_SCENARIOS: ReadonlySet<string> = new Set([
  'compile-is-pure',
  'compile-refuses-an-unreadable-policy',
  'no-provider-credential-in-the-sandbox',
  'gateway-is-programmatic',
  'a-read-only-grant-is-not-writable',
  'the-protected-config-directory-is-declared-and-closed',
  'the-portable-permissions-decide-the-tool-policy',
  'skills-are-placed-inside-the-declared-config-directory',
  'connectors-are-honoured-or-refused-by-name',
]);

/**
 * The engine-native policy arm every conformance subject below compiles.
 *
 * Since ENG-04b (#325) the §17 agent itself is the *portable* half and the conformance kit supplies
 * it; what a subject has to declare is the arm only its own engine can read.
 */
const MATRIX_CLAUDE_POLICY = { tools: null, fileGrantDeny: [] } as const;

/** One column: an adapter, and the conformance subject that drives it. */
type Column = {
  readonly id: string;
  readonly adapter: AgentEngine;
  readonly subject: EngineConformanceSubject<never>;
};

const claudeSubject: EngineConformanceSubject<CompiledSdkOptions> = {
  engine: CLAUDE_AGENT_SDK_ENGINE_ADAPTER,
  policy: MATRIX_CLAUDE_POLICY,
  unreadablePolicy: { tools: 'every-tool' },
  compiledEnv: (compiled) => compiled.env,
  writeAllowed: claudeOptionsAllowWrite,
  permissionAllowed: claudeOptionsAllowPermission,
  connectorsCompiled: (compiled) => Object.keys(compiled.mcpServers),
  subagentsCompiled: (compiled) => Object.keys(compiled.agents ?? {}),
  gatewayEnv: claudeGatewayEnv,
};

/**
 * The OpenAI Agents subject (ENG-09, #308). Its arm is two optional model settings, so `{}` is a
 * readable policy. The kit's portable core names no model, which an OpenAI-family connection
 * accepts (the SDK's default model) and an Anthropic-family one refuses, so the subject's gateway
 * serves the Responses dialect.
 */
const openAiAgentsSubject: EngineConformanceSubject<OpenAiAgentsCompiled> = {
  engine: OPENAI_AGENTS_ENGINE_ADAPTER,
  policy: {},
  unreadablePolicy: { tools: null, fileGrantDeny: [] },
  compiledEnv: (compiled) => compiled.env,
  writeAllowed: (compiled, candidate) => workspaceWriteAllowed(compiled.workspace, candidate),
  permissionAllowed: (compiled, permission) =>
    openAiAgentsPlanAllowsPermission(
      { tools: compiled.agent.tools, networkEgress: compiled.networkEgress },
      permission,
    ),
  connectorsCompiled: (compiled) => compiled.mcpServers.map((server) => server.name),
  subagentsCompiled: (compiled) => compiled.subagents.map((subagent) => subagent.name),
  gateway: createScriptedGateway({ protocol: 'openai-responses' }),
};

/**
 * The pi subject (ENG-08, #307). Its arm is one optional thinking level, so `{}` is a readable
 * policy, and it speaks Anthropic Messages alone; the kit's portable core names no model, which
 * compiles to pi's own default Anthropic model.
 */
const piSubject: EngineConformanceSubject<PiCompiled> = {
  engine: PI_ENGINE_ADAPTER,
  policy: {},
  unreadablePolicy: { tools: null, fileGrantDeny: [] },
  compiledEnv: (compiled) => compiled.env,
  writeAllowed: (compiled, candidate) => piWorkspaceWriteAllowed(compiled.workspace, candidate),
  permissionAllowed: (compiled, permission) =>
    piPlanAllowsPermission(
      { tools: compiled.agent.tools, networkEgress: compiled.networkEgress },
      permission,
    ),
  gateway: createScriptedGateway({ protocol: 'anthropic-messages' }),
};

/**
 * The Mastra subject (ENG-10, #309). Its arm is one optional tool-call concurrency, so `{}` is a
 * readable policy; the kit's portable core names no model, which compiles to the adapter's default
 * for the protocol, and its connector compiles to an `MCPClient` server.
 */
const mastraSubject: EngineConformanceSubject<MastraCompiled> = {
  engine: MASTRA_ENGINE_ADAPTER,
  policy: {},
  unreadablePolicy: { toolCallConcurrency: 0 },
  compiledEnv: (compiled) => compiled.env,
  writeAllowed: (compiled, candidate) => mastraWriteAllowed(compiled.workspace, candidate),
  permissionAllowed: (compiled, permission) =>
    mastraPlanAllowsPermission(
      { tools: compiled.agent.tools, networkEgress: compiled.networkEgress },
      permission,
    ),
  connectorsCompiled: (compiled) => compiled.mcpServers.map((server) => server.name),
  subagentsCompiled: (compiled) => compiled.subagents.map((subagent) => subagent.name),
  gateway: createScriptedGateway({ protocol: 'anthropic-messages' }),
};

/** Every adapter this repository ships, in catalogue order. */
export const ENGINE_MATRIX_COLUMNS: readonly Column[] = [
  {
    id: CLAUDE_AGENT_SDK_ENGINE_ID,
    adapter: CLAUDE_AGENT_SDK_ENGINE_ADAPTER,
    subject: claudeSubject as unknown as EngineConformanceSubject<never>,
  },
  {
    id: OPENAI_AGENTS_ENGINE_ID,
    adapter: OPENAI_AGENTS_ENGINE_ADAPTER,
    subject: openAiAgentsSubject as unknown as EngineConformanceSubject<never>,
  },
  {
    id: PI_ENGINE_ID,
    adapter: PI_ENGINE_ADAPTER,
    subject: piSubject as unknown as EngineConformanceSubject<never>,
  },
  {
    id: MASTRA_ENGINE_ID,
    adapter: MASTRA_ENGINE_ADAPTER,
    subject: mastraSubject as unknown as EngineConformanceSubject<never>,
  },
];

function tick(value: boolean): string {
  return value ? '✓' : '-';
}

async function conformanceCell(column: Column): Promise<string> {
  const failures: string[] = [];
  let ran = 0;
  for (const scenario of CONFORMANCE_SCENARIOS) {
    if (!COMPILE_ONLY_SCENARIOS.has(scenario.name)) continue;
    ran += 1;
    const verdict = await scenario.run(column.subject);
    if (!verdict.pass) failures.push(`${verdict.scenario}: ${verdict.reason}`);
  }
  if (ran === 0) throw new Error('the engine matrix ran no conformance scenario at all');
  return failures.length === 0
    ? `${String(ran)}/${String(ran)} PASS`
    : `FAIL — ${failures.join('; ')}`;
}

/**
 * Render the matrix.
 *
 * Throws when a boolean capability the contracts publish has no row: a capability nobody can
 * compare across engines is the one thing this file exists to prevent, so its omission is a
 * failure rather than a quietly shorter table.
 */
export async function renderEngineMatrix(): Promise<string> {
  const first = ENGINE_MATRIX_COLUMNS[0];
  if (first === undefined) throw new Error('the engine matrix has no columns');

  const valued: ReadonlySet<string> = new Set(['maxTurns', 'maxBudget', 'wireProtocols']);
  const shown = new Set<string>(CAPABILITY_ROWS.map((row) => row.key));
  const missing = Object.keys(first.adapter.capabilities).filter(
    (key) => !valued.has(key) && !shown.has(key),
  );
  if (missing.length > 0) {
    throw new Error(
      `docs/engine-matrix.md would omit ${missing.join(', ')}: add a row to tests/engine-matrix/renderer.ts.`,
    );
  }

  const ids = ENGINE_MATRIX_COLUMNS.map((column) => column.id);
  const lines: string[] = [
    '# Engine matrix',
    '',
    'Generated by `node tests/engine-matrix/run.mjs` (and gated by `tests/engine-matrix.test.ts`).',
    "Every cell is derived: the capability rows from each adapter's own declaration — the value",
    '`apps/runner` actually consults — and the conformance row from running',
    '`@agent-workspace/engine/testing` against that adapter. Do not edit this file by hand.',
    '',
    `| Capability | ${ids.join(' | ')} |`,
    `| --- | ${ids.map(() => '---').join(' | ')} |`,
  ];

  for (const row of CAPABILITY_ROWS) {
    const cells = ENGINE_MATRIX_COLUMNS.map((column) =>
      tick(column.adapter.capabilities[row.key] === true),
    );
    lines.push(`| ${row.label} | ${cells.join(' | ')} |`);
  }
  lines.push(
    `| Turn limit enforced by | ${ENGINE_MATRIX_COLUMNS.map(
      (column) => column.adapter.capabilities.maxTurns,
    ).join(' | ')} |`,
    `| Budget enforced by | ${ENGINE_MATRIX_COLUMNS.map(
      (column) => column.adapter.capabilities.maxBudget,
    ).join(' | ')} |`,
    `| Gateway dialects | ${ENGINE_MATRIX_COLUMNS.map((column) =>
      [...column.adapter.capabilities.wireProtocols].join(', '),
    ).join(' | ')} |`,
    `| Protected config directory | ${ENGINE_MATRIX_COLUMNS.map(
      (column) => `\`${column.adapter.protectedConfigDirectory}\``,
    ).join(' | ')} |`,
    `| Adapter version | ${ENGINE_MATRIX_COLUMNS.map((column) => column.adapter.version).join(' | ')} |`,
  );

  const conformance: string[] = [];
  for (const column of ENGINE_MATRIX_COLUMNS) conformance.push(await conformanceCell(column));
  lines.push(`| Conformance (compile scenarios) | ${conformance.join(' | ')} |`);

  lines.push(
    '',
    'The conformance row reports the **compile-only** scenarios, which are the ones a generator',
    "can run: an adapter's `start` spawns its engine and needs a credential. The whole kit —",
    'the run, the reported session id, the durability verdict and the interrupt as well — runs',
    "against recorded engine messages in each adapter's own test file, and the full list is",
    `${String(CONFORMANCE_SCENARIOS.length)} scenarios.`,
    '',
    'The capability keys a *save* can be refused for are',
    `${ENGINE_CAPABILITY_KEYS.map((key) => `\`${key}\``).join(', ')}: an agent assigned a`,
    'connector, a skill or a subagent its engine cannot honour is `422 engine_capability_unsupported`',
    'rather than a run quietly without them.',
    '',
  );

  return lines.join('\n');
}
