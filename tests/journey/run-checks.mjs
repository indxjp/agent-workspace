/**
 * The journey's checks made with `aw` and the shell in the clean machine rather than in a browser:
 * the project's agent file, the engine capability refusal, the stub evaluation, the versions.
 */
import { performance } from 'node:perf_hooks';

import { JourneyFailure, agentNameOfSource, mcpAgentSource } from './harness.mjs';
import { DEMO_IN, DEMO_MCP_IN, exec, execOk, nonce, say, writeIn } from './run-support.mjs';

const CONNECTOR_NAME = 'journey-mcp';
/** A loopback MCP URL nothing listens on: the check refuses the engine before anything dials it. */
const CONNECTOR_URL = 'http://127.0.0.1:9/mcp';
const CONNECTOR_FILE_IN = '/tmp/journey-connector.json';
const EVALUATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * The project's one agent file, `agents/<name>.ts`.
 *
 * @param {string} machine @param {(capMs: number) => number} limit
 */
export async function agentFile(machine, limit) {
  const listing = await execOk(machine, ['ls', 'agents'], {
    workdir: DEMO_IN,
    timeoutMs: limit(30_000),
    quiet: true,
  });
  const files = listing.stdout.split('\n').filter((file) => file.endsWith('.ts'));
  const [file] = files;
  if (file === undefined || files.length !== 1) {
    throw new JourneyFailure(`demo/agents holds ${String(files.length)} agent files, not one`);
  }
  const source = await execOk(machine, ['cat', `agents/${file}`], {
    workdir: DEMO_IN,
    timeoutMs: limit(30_000),
    quiet: true,
  });
  return { file: `agents/${file}`, source: source.stdout };
}

/**
 * A copy of `demo/` whose agent has an `mcp()` tool on engine `pi` (no MCP client): `aw check`
 * must refuse it with `422 engine_capability_unsupported [mcp]`. The connector is created through
 * `aw` first, because the save pipeline resolves names before it checks capabilities.
 *
 * @param {string} machine @param {{ file: string, source: string }} agent
 * @param {(capMs: number) => number} limit
 */
export async function checkMcpOnPi(machine, agent, limit) {
  await execOk(machine, ['sh', '-c', `cat > ${CONNECTOR_FILE_IN}`], {
    input: JSON.stringify({ name: CONNECTOR_NAME, transport: 'http', url: CONNECTOR_URL }),
    timeoutMs: limit(30_000),
  });
  await execOk(machine, ['npx', 'aw', 'connectors', 'create', '--file', CONNECTOR_FILE_IN], {
    workdir: DEMO_IN,
    timeoutMs: limit(120_000),
  });
  await execOk(
    machine,
    [
      'sh',
      '-c',
      `mkdir ${DEMO_MCP_IN} && tar -C ${DEMO_IN} --exclude=./node_modules --exclude=./.agent-workspace -cf - . | tar -C ${DEMO_MCP_IN} -xf - && ln -s ../demo/node_modules ${DEMO_MCP_IN}/node_modules`,
    ],
    { timeoutMs: limit(120_000) },
  );
  await execOk(machine, ['sh', '-c', `cat > ${DEMO_MCP_IN}/${agent.file}`], {
    input: mcpAgentSource(agent.source, CONNECTOR_NAME),
    timeoutMs: limit(30_000),
  });
  const check = await exec(machine, ['npx', 'aw', 'check'], {
    workdir: DEMO_MCP_IN,
    timeoutMs: limit(180_000),
  });
  const expected = `${agent.file}: 422 engine_capability_unsupported [mcp]`;
  if (
    check.status !== 1 ||
    !check.output.split('\n').some((line) => line.trim().endsWith(expected))
  ) {
    throw new JourneyFailure(
      `aw check on mcp() with engine pi exited ${String(check.status)} without "${expected}"`,
    );
  }
  say(`journey: ${expected}`);
}

/**
 * The two cases the stub model answers deterministically: the orders tool for a prompt with a
 * nonce, the slice-1 reply for one without.
 *
 * @param {string} tool the orders tool's name as the model was offered it
 */
function stubEvalCases(tool) {
  const evalNonce = nonce();
  return [
    'cases:',
    '  - name: order status uses the tool',
    `    input: "What is the status of order ${evalNonce}?"`,
    `    expect: { tool: ${JSON.stringify(tool)}, contains: ["order-data-${evalNonce}"] }`,
    '  - name: no refund promises',
    '    input: "I want my money back now"',
    '    expect: { notContains: ["refund"] }',
    '',
  ].join('\n');
}

/**
 * Whether `aw eval --json` passed 2/2 with score 1 and a stored id; the failure is the results.
 *
 * @param {{ id?: unknown, passed?: unknown, total?: unknown, score?: unknown, results?: unknown }} evaluation
 */
function assertEvaluationPassed(evaluation) {
  if (
    evaluation.passed !== 2 ||
    evaluation.total !== 2 ||
    evaluation.score !== 1 ||
    typeof evaluation.id !== 'string' ||
    !EVALUATION_ID.test(evaluation.id)
  ) {
    throw new JourneyFailure(`aw eval did not pass 2/2: ${JSON.stringify(evaluation.results)}`);
  }
}

/**
 * Issue #618: write `evals/<agent>.yaml` with two cases the stub model answers deterministically
 * (the orders tool for a prompt with a nonce, the slice-1 reply for one without), run
 * `aw eval <agent> --json`, and require 2/2, score 1 and a stored id. Says the step's seconds.
 *
 * @param {string} machine
 * @param {{ agent: { readonly source: string },
 *   toolRequests: readonly { nonce: string | null, toolNames: readonly string[] }[],
 *   toolNonce: string, limit: (capMs: number) => number }} options
 *   `toolNonce` is a nonce whose turn offered the orders tool, to read the tool's name
 */
export async function evaluateAgainstStub(machine, options) {
  const { limit } = options;
  const started = performance.now();
  const name = agentNameOfSource(options.agent.source);
  const tool = options.toolRequests
    .filter((request) => request.nonce === options.toolNonce)
    .flatMap((request) => request.toolNames)
    .find((toolName) => toolName.endsWith('__getOrderByOrderNumber'));
  if (tool === undefined) throw new JourneyFailure('no model request offered the orders tool');
  await writeIn(machine, `${DEMO_IN}/evals/${name}.yaml`, stubEvalCases(tool), limit(30_000));
  const result = await execOk(machine, ['npx', 'aw', 'eval', name, '--json'], {
    workdir: DEMO_IN,
    timeoutMs: limit(240_000),
    quiet: true,
  });
  /** @type {{ id?: unknown, passed?: unknown, total?: unknown, score?: unknown, results?: unknown }} */
  const evaluation = JSON.parse(result.stdout);
  assertEvaluationPassed(evaluation);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  say(
    `journey: aw eval ${name} passed 2/2, stored as evaluation ${String(evaluation.id)} (${seconds}s)`,
  );
}

/**
 * @param {string} machine @param {string} agentId @param {(capMs: number) => number} limit
 */
export async function versionsOf(machine, agentId, limit) {
  const listing = await execOk(
    machine,
    ['npx', 'aw', 'agents', 'versions', 'list', agentId, '--json'],
    { workdir: DEMO_IN, timeoutMs: limit(120_000), quiet: true },
  );
  return JSON.stringify(JSON.parse(listing.stdout));
}
