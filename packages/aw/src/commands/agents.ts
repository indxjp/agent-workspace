import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { AGENT_VERSION_NUMBER_MAX } from '@indx-workspace/contracts/agent-versions';
import {
  AGENT_DEFINITION_ON_MISSING,
  translatePolicyForEngineSwitch,
  type AgentDefinition,
  type AgentPolicy,
  type AgentResource,
  type AgentResourceAssignmentsInput,
  type EngineSwitchTranslation,
} from '@indx-workspace/contracts/agents';
import { isWithholdingEngine, type EngineId } from '@indx-workspace/contracts/engines';
import { z } from 'zod';

import {
  command,
  enumValue,
  integerValue,
  isOn,
  positional,
  readBody,
  value,
  values,
  type Command,
  type CommandContext,
} from '../command.js';
import { UsageError } from '../io.js';
import { exportAgentAsCode } from '../project/index.js';
import { projectRoot } from './project.js';
import {
  AgentAssignmentsBody,
  AgentDefinitionBody,
  AgentGrantsBody,
  AgentPolicyBody,
  CreateAgentBody,
  UpdateAgentBody,
  exact,
} from '../inputs.js';

const AGENT_EXPORT_FORMATS = ['json', 'ts'] as const;

const AGENT_COLUMNS = [
  'id',
  'name',
  'model',
  'modelConnectionId',
  'runtimeProfileId',
  'updatedAt',
  'builtin',
];

/**
 * `agents create`'s `--skill`/`--connector`/`--grant-file` (S-13/K-2, issue #234), composed into
 * the `assignments` the SDK's `create(input, { assignments })` second parameter takes. `null` —
 * not an object with three empty arrays — when none of the three flags was given at all, so a
 * plain `aw agents create --file agent.json` still posts the bare input it always has and never
 * turns into a compound create the caller did not ask for.
 */
function parseFileAccess(raw: string): 'read' | 'read-write' {
  if (raw === 'read' || raw === 'read-write') return raw;
  throw new UsageError(
    `--grant-file's access must be "read" or "read-write", got ${JSON.stringify(raw)}`,
  );
}

function readAssignmentFlags(context: CommandContext): AgentResourceAssignmentsInput | null {
  const skillIds = values(context, 'skill');
  const connectorIds = values(context, 'connector');
  const grantFiles = values(context, 'grant-file');
  if (skillIds.length === 0 && connectorIds.length === 0 && grantFiles.length === 0) return null;
  const files = grantFiles.map((entry) => {
    const separator = entry.indexOf(':');
    const fileId = separator === -1 ? entry : entry.slice(0, separator);
    if (fileId === '') {
      throw new UsageError(
        `--grant-file must be <fileId> or <fileId>:read|read-write, got ${JSON.stringify(entry)}`,
      );
    }
    const access = parseFileAccess(separator === -1 ? 'read' : entry.slice(separator + 1));
    return { fileId, access };
  });
  return { files, skillIds: [...skillIds], connectorIds: [...connectorIds] };
}

/**
 * `--engine <id>` (issue #319, ENG-02c): the engine this agent's policy names, resolved against
 * the deployment's own catalogue **before** anything is created or changed.
 *
 * The catalogue is the authority, not `ENGINE_IDS`: the contracts publish what the platform knows
 * how to describe, while `GET /api/engines` answers what this deployment installs, and
 * `PUT /api/agents/:id/policy` refuses an engine against exactly that list
 * (`400 unsupported_engine`). Asking first is what makes an unregistered engine a refusal with
 * nothing written, rather than an agent created and then left on an engine the caller did not ask
 * for. It is stricter than the route in one respect: a descriptor whose `installed` is `false` is
 * refused too, the same engines the agent editor hides. `null` when the flag was not given; the policy arm is then whatever the server derives,
 * which is `claude-agent-sdk`.
 */
async function resolveEngineFlag(context: CommandContext): Promise<EngineId | null> {
  const requested = value(context, 'engine');
  if (requested === undefined) return null;
  const engines = await context.client.engines.list({ signal: context.signal });
  // An `installed: false` descriptor is one the catalogue knows and this deployment cannot run:
  // the agent editor hides it, so the flag refuses it rather than pin a policy to it.
  const match = engines.find((engine) => engine.id === requested && engine.installed);
  if (match === undefined) {
    const installed = engines.filter((engine) => engine.installed).map((engine) => engine.id);
    throw new UsageError(
      `unsupported_engine: this deployment installs ` +
        `${installed.length === 0 ? 'no engine at all' : installed.join(', ')}` +
        `, and --engine named ${JSON.stringify(requested)}. Run "aw engines list" to see them.`,
    );
  }
  return match.id;
}

/**
 * Store the agent's policy under `engine`.
 *
 * The engine is a field of the policy, and the policy has exactly one route: read it, replace the
 * discriminant, write it back. Read-then-write rather than a fabricated body, so every other field
 * — the tool grammar, the skill allowlist, the limits — is whatever the server already had for
 * this agent and `--engine` changes precisely one thing.
 *
 * It does leave a *stored* policy behind on an agent that had none, and a stored policy is a
 * snapshot: `GET` answers a compiled policy for an agent nobody has `PUT` one onto, and that
 * compiled policy lists the agent's currently assigned and enabled skills as an allowlist. Writing
 * it back pins that list, so a skill assigned later no longer reaches the agent until the policy is
 * set again. That is the same consequence `aw agents policy set` has, and `--engine` is an explicit
 * request to set the policy arm rather than something that happens by default.
 */
async function applyEngine(
  context: CommandContext,
  agentId: string,
  engine: EngineId,
): Promise<void> {
  const policy = await context.client.agents.getPolicy(agentId, { signal: context.signal });
  await context.client.agents.replacePolicy(agentId, policyOnEngine(context, policy, engine), {
    signal: context.signal,
  });
}

/**
 * The translation, as `--engine` prints it before it applies it: what the new arm carries, what
 * needs no carrying because the new engine has no such tool, and what would be refused.
 */
function describeTranslation(
  from: AgentPolicy['engine'],
  to: EngineId,
  translation: EngineSwitchTranslation,
): string {
  const lines = [`engine switch ${from} -> ${to}:`];
  for (const item of translation.carried) {
    // A carried `unrestrictedNetwork` withholds egress rather than a tool, so its list is empty.
    const withheld = item.tools.length === 0 ? '(network egress)' : item.tools.join(', ');
    lines.push(`  carried  ${item.from} -> withholds ${withheld}`);
  }
  for (const rule of translation.absent) {
    lines.push(`  absent   ${rule} (${to} has no such tool, so it stays absent)`);
  }
  if (!translation.ok) {
    for (const rule of translation.refused) {
      lines.push(`  refused  ${rule} (${to} cannot express this denial)`);
    }
  }
  if (lines.length === 1) lines.push('  nothing to carry: the policy narrows no tool');
  return `${lines.join('\n')}\n`;
}

/**
 * The same policy, on `engine` (ENG-09, #308; `pi` since ENG-08, #307; `mastra` since ENG-10, #309).
 *
 * The portable half — `skills` and `limits` — always carries over. The engine-native half does
 * only when the engine does not change: the Claude arm's `tools` is that engine's own grammar and
 * means nothing to `openai-agents`, `pi` or `mastra`. What that grammar *withheld* is carried, though:
 * the contracts'
 * `translatePolicyForEngineSwitch` — the function the route enforces (ADR-0074 D12) — writes the
 * Claude arm's `tools.deny` and narrowing `permissionMode` into the new arm's
 * `withheldPermissions`, and this prints that translation on stderr before anything is written. A
 * denial the new arm cannot express (an MCP tool, a wildcard) is refused here as
 * `engine_switch_would_widen`, with nothing written, exactly as the route would refuse it.
 *
 * Moving an agent **to** `claude-agent-sdk` from another engine would need a tool grammar nobody
 * wrote, so it is refused with the command that writes one, rather than invented here.
 */
function policyOnEngine(
  context: CommandContext,
  policy: AgentPolicy,
  engine: EngineId,
): AgentPolicy {
  if (policy.engine === engine) return policy;
  if (isWithholdingEngine(engine)) {
    const translation = translatePolicyForEngineSwitch(policy, {
      engine,
      skills: policy.skills,
      limits: policy.limits,
    });
    context.io.stderr(describeTranslation(policy.engine, engine, translation));
    if (!translation.ok) {
      throw new UsageError(
        `engine_switch_would_widen: moving this agent to ${engine} would drop the denial` +
          `${translation.refused.length === 1 ? '' : 's'} ${translation.refused.join(', ')}, which ` +
          `${engine} cannot express. Remove ${translation.refused.length === 1 ? 'it' : 'them'} ` +
          'from the policy (or turn off the permission it guards) and switch again.',
      );
    }
    return translation.policy;
  }
  throw new UsageError(
    `this agent's policy is on ${policy.engine}; moving it to ${engine} needs that engine's own ` +
      'tool policy. Write the whole policy with "aw agents policy set <id> --file <json>".',
  );
}

/** Whether `agents update` was given anything to `PATCH` beyond `--engine`. */
function hasDefinitionPatch(context: CommandContext): boolean {
  return value(context, 'file') !== undefined || value(context, 'name') !== undefined;
}

/** The agent an `agents create` result carries, whether or not assignments came back with it. */
function createdAgent(result: AgentResource | { readonly agent: AgentResource }): AgentResource {
  return 'agent' in result ? result.agent : result;
}

/**
 * `agents import <file>`: the definition from a file, or from stdin for `-`, validated against the
 * contract before anything is sent — a malformed or credential-carrying file costs no request.
 */
async function readDefinition(context: CommandContext): Promise<AgentDefinition> {
  const source = positional(context, 0, 'file');
  let text: string;
  if (source === '-') {
    text = await context.readStdin();
  } else {
    try {
      text = await readFile(source, 'utf8');
    } catch {
      throw new UsageError(`could not read ${source}`);
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UsageError(`${source} is not JSON`);
  }
  try {
    return exact(AgentDefinitionBody, json);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '$'}: ${issue.message}`)
        .join('; ');
      throw new UsageError(`${source} is not an agentworkspace.dev/v1 AgentDefinition: ${issues}`);
    }
    throw error;
  }
}

/**
 * §5.9 — `aw agents`. `restore` brings back an agent the auto-archive sweep archived (#1851); there is no
 * `archive` command, because only the sweep archives. `remove` cascades through the agent's sessions and runs today.
 */
export const agentCommands: readonly Command[] = [
  command('agents list', '', 'Every agent', async ({ client, signal, mode }) => {
    const agents = await client.agents.list({ signal });
    // --json and --jsonl keep the wire value (`builtin: 'builder'`); the table says "Built-in".
    const machine = mode.json || mode.jsonl;
    return {
      value: machine
        ? agents
        : agents.map((agent) =>
            agent.builtin === undefined ? agent : { ...agent, builtin: 'Built-in' },
          ),
      columns: AGENT_COLUMNS,
    };
  }),
  command('agents get', '<id>', 'One agent', async (context) => ({
    value: await context.client.agents.get(positional(context, 0, 'id'), {
      signal: context.signal,
    }),
  })),
  command(
    'agents create',
    '--file <json> [--name <name>] [--engine <id>] [--skill <id>]... [--connector <id>]... [--grant-file <id>[:read|read-write]]...',
    'Create an agent, optionally with its resource assignments in one call',
    async (context) => {
      const input = await readBody(context, CreateAgentBody, { name: value(context, 'name') });
      const assignments = readAssignmentFlags(context);
      // After the local arguments, so a malformed command costs no request; before the create, so
      // an engine this deployment does not install leaves no agent behind.
      const engine = await resolveEngineFlag(context);
      const created =
        assignments === null
          ? await context.client.agents.create(input, { signal: context.signal })
          : await context.client.agents.create(input, { assignments, signal: context.signal });
      if (engine !== null) {
        const agentId = createdAgent(created).id;
        try {
          await applyEngine(context, agentId, engine);
        } catch (error) {
          // The agent exists now, so re-running this create would make a second one. Name it and
          // the command that finishes the job, then fail with the original classification.
          context.io.stderr(
            `agent ${agentId} was created, but setting its engine failed; ` +
              `retry with "aw agents update ${agentId} --engine ${engine}"
`,
          );
          throw error;
        }
      }
      return { value: created };
    },
  ),
  command(
    'agents update',
    '<id> [--file <json>] [--name <name>] [--engine <id>]',
    'Change an agent (a runtime switch is `{ "runtimeProfileId": … }`)',
    async (context) => {
      const id = positional(context, 0, 'id');
      // `--engine` alone is a complete command: it changes the policy arm and nothing else, so
      // there is no patch to send. With no flag at all `readBody` still explains itself.
      const patch =
        value(context, 'engine') !== undefined && !hasDefinitionPatch(context)
          ? null
          : await readBody(context, UpdateAgentBody, { name: value(context, 'name') });
      // After the local arguments, so a malformed command costs no request.
      const engine = await resolveEngineFlag(context);
      const agent =
        patch === null
          ? await context.client.agents.get(id, { signal: context.signal })
          : await context.client.agents.update(id, patch, { signal: context.signal });
      if (engine !== null) await applyEngine(context, id, engine);
      return { value: agent };
    },
  ),
  command(
    'agents restore',
    '<id>',
    'Bring back an archived agent and print its name',
    async (context) => {
      const agent = await context.client.agents.restore(positional(context, 0, 'id'), {
        signal: context.signal,
      });
      // The name is user-authored: a control or format character in it (an escape sequence, a
      // bidi override, a zero-width space) must not reach the terminal.
      return {
        value:
          context.mode.json || context.mode.jsonl
            ? agent
            : agent.name.replace(/[\p{Cc}\p{Cf}]/gu, ''),
      };
    },
  ),
  command(
    'agents remove',
    '<id>',
    'Delete an agent and, today, its sessions and runs',
    async (context) => {
      await context.client.agents.remove(positional(context, 0, 'id'), { signal: context.signal });
      return { value: undefined };
    },
  ),
  command(
    'agents assignments get',
    '<id>',
    'The files, skills and connectors the agent may reach',
    async (context) => ({
      value: await context.client.agents.getResourceAssignments(positional(context, 0, 'id'), {
        signal: context.signal,
      }),
    }),
  ),
  command(
    'agents assignments set',
    '<id> --file <json>',
    'Replace every assignment at once',
    async (context) => ({
      value: await context.client.agents.replaceResourceAssignments(
        positional(context, 0, 'id'),
        await readBody(context, AgentAssignmentsBody),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'agents grants get',
    '<id>',
    'Membership principals permitted to run this agent',
    async (context) => ({
      value: await context.client.agents.getGrants(positional(context, 0, 'id'), {
        signal: context.signal,
      }),
    }),
  ),
  command(
    'agents grants set',
    '<id> --file <json>',
    'Replace every Viewer grant at once',
    async (context) => {
      const grants = await readBody(context, AgentGrantsBody);
      return {
        value: await context.client.agents.replaceGrants(
          positional(context, 0, 'id'),
          grants.principalIds,
          { signal: context.signal },
        ),
      };
    },
  ),
  command(
    'agents policy get',
    '<id>',
    "The agent's policy (S-13) — stored, or compiled when none was ever set",
    async (context) => ({
      value: await context.client.agents.getPolicy(positional(context, 0, 'id'), {
        signal: context.signal,
      }),
    }),
  ),
  command(
    'agents policy set',
    '<id> --file <json>',
    "Replace the agent's policy as one operation (S-13)",
    async (context) => ({
      value: await context.client.agents.replacePolicy(
        positional(context, 0, 'id'),
        await readBody(context, AgentPolicyBody),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'agents export',
    '<id> [--format json|ts] [--agent-version <n>] [--out <dir>] [--force]',
    'The agent as a portable definition (K-1): aw agents export <id> > agent.json; --format ts writes agents/<name>.ts and .md for aw push',
    async (context) => {
      const id = positional(context, 0, 'id');
      const format = enumValue(context, 'format', AGENT_EXPORT_FORMATS) ?? 'json';
      if (format === 'ts') {
        const version = integerValue(context, 'agent-version');
        if (version !== undefined && version > AGENT_VERSION_NUMBER_MAX) {
          throw new UsageError('--agent-version is out of range');
        }
        const root = projectRoot(context);
        await exportAgentAsCode({
          client: context.client,
          io: context.io,
          signal: context.signal,
          agentId: id,
          out: path.resolve(root, value(context, 'out') ?? '.'),
          version,
          force: isOn(context, 'force'),
        });
        return undefined;
      }
      for (const flag of ['agent-version', 'out'] as const) {
        if (value(context, flag) !== undefined) {
          throw new UsageError(`--${flag} needs --format ts`);
        }
      }
      if (isOn(context, 'force')) throw new UsageError('--force needs --format ts');
      const definition = await context.client.agents.export(id, {
        signal: context.signal,
      });
      // Always JSON, whatever the output mode: the output is a file format, not a report.
      context.io.stdout(`${JSON.stringify(definition, null, 2)}
`);
      return undefined;
    },
  ),
  command(
    'agents import',
    '<file|-> [--on-missing fail|skip]',
    'Recreate an exported agent here, resolving skills and connectors by name (K-1)',
    async (context) => {
      const definition = await readDefinition(context);
      const onMissing = enumValue(context, 'on-missing', AGENT_DEFINITION_ON_MISSING) ?? 'fail';
      const result = await context.client.agents.import(definition, {
        onMissing,
        signal: context.signal,
      });
      for (const skipped of result.skipped) {
        context.io.stderr(`skipped ${skipped}: not in this workspace
`);
      }
      return { value: result };
    },
  ),
];
