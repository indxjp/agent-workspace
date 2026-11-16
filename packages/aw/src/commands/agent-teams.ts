import {
  AGENT_TEAM_MEMBERS_MAX,
  isAgentTeamMemberName,
  type AgentTeamPin,
  type AgentTeamResource,
  type AgentTeamVersion,
  type CreateAgentTeamVersionRequest,
} from '@indx-workspace/contracts/agent-teams';
import { AGENT_VERSION_NUMBER_MAX } from '@indx-workspace/contracts/agent-versions';

import {
  command,
  positional,
  value,
  values,
  type Command,
  type CommandContext,
} from '../command.js';
import { CommandRefusedError, UsageError } from '../io.js';
import { deliverStarted, idempotencyKeyOf, startDeliveryOf } from './runs.js';

const TEAM_COLUMNS = ['id', 'name', 'version', 'lead', 'members', 'createdAt'];
const VERSION_COLUMNS = ['version', 'lead', 'members', 'createdAt'];

/** One `--lead`/`--member` value: `[<member name>=]<agent>[@<version>]`. */
export interface MemberSpec {
  /** The team-local member name, when the value names one; the agent's name otherwise. */
  readonly name?: string;
  /** An agent's exact name, or its id. */
  readonly agent: string;
  /** The agent version number to pin; the one `local` points at when absent. */
  readonly version?: number;
}

/**
 * Read `[<member name>=]<agent>[@<version>]`. The member name is taken only when what precedes the
 * first `=` is a valid member name (a slug), and the version only when what follows the last `@`
 * is a number, so an agent name holding either character still resolves as a whole.
 */
export function parseMemberSpec(raw: string, flag: 'lead' | 'member'): MemberSpec {
  let rest = raw.trim();
  let name: string | undefined;
  const equals = rest.indexOf('=');
  if (flag === 'member' && equals > 0 && isAgentTeamMemberName(rest.slice(0, equals))) {
    name = rest.slice(0, equals);
    rest = rest.slice(equals + 1);
  }
  let version: number | undefined;
  const at = rest.lastIndexOf('@');
  if (at > 0 && /^[1-9][0-9]*$/u.test(rest.slice(at + 1))) {
    version = Number(rest.slice(at + 1));
    if (!Number.isSafeInteger(version) || version > AGENT_VERSION_NUMBER_MAX) {
      throw new UsageError(
        `--${flag} ${JSON.stringify(raw)}: the version must be at most ${String(AGENT_VERSION_NUMBER_MAX)}`,
      );
    }
    rest = rest.slice(0, at);
  }
  if (rest === '') throw new UsageError(`--${flag} ${JSON.stringify(raw)} names no agent`);
  return {
    agent: rest,
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
  };
}

/** The team named `nameOrId` (an exact name, else an id), or a refusal naming it. */
async function teamNamed(context: CommandContext, nameOrId: string): Promise<AgentTeamResource> {
  const teams: AgentTeamResource[] = [];
  for await (const team of context.client.agentTeams.listAll({}, { signal: context.signal })) {
    teams.push(team);
  }
  const team =
    teams.find((candidate) => candidate.name === nameOrId) ??
    teams.find((candidate) => candidate.id === nameOrId);
  if (team === undefined) {
    throw new CommandRefusedError(
      `no agent team named ${JSON.stringify(nameOrId)}`,
      'run aw agent-teams list',
    );
  }
  return team;
}

/** Resolve each spec to an `(agentId, agentVersionId)` pin, reading the agents once. */
async function pinsOf(
  context: CommandContext,
  specs: readonly MemberSpec[],
): Promise<readonly AgentTeamPin[]> {
  const agents = await context.client.agents.list({ signal: context.signal });
  const pins: AgentTeamPin[] = [];
  for (const spec of specs) {
    const agent =
      agents.find((candidate) => candidate.name === spec.agent) ??
      agents.find((candidate) => candidate.id === spec.agent);
    if (agent === undefined) {
      throw new CommandRefusedError(
        `no agent named ${JSON.stringify(spec.agent)}`,
        'run aw agents list',
      );
    }
    const listing = await context.client.agents.versions.list(agent.id, { signal: context.signal });
    const number =
      spec.version ??
      listing.pointers.find((pointer) => pointer.environment === 'local')?.number ??
      listing.items.reduce((newest, item) => Math.max(newest, item.number), 0);
    const pinned = listing.items.find((item) => item.number === number);
    if (pinned === undefined) {
      throw new CommandRefusedError(
        spec.version === undefined
          ? `agent ${JSON.stringify(agent.name)} has no version yet`
          : `agent ${JSON.stringify(agent.name)} has no version ${String(spec.version)}`,
        'run aw push --yes',
      );
    }
    pins.push({ agentId: agent.id, agentVersionId: pinned.id });
  }
  return pins;
}

/**
 * The version `--lead` and `--member` describe. `--lead` defaults to `fallbackLead` (the team's
 * current lead) when the command has one, and at least one `--member` is required.
 */
async function versionRequest(
  context: CommandContext,
  fallbackLead: AgentTeamPin | null,
): Promise<CreateAgentTeamVersionRequest> {
  const leadRaw = value(context, 'lead');
  const memberSpecs = values(context, 'member').map((raw) => parseMemberSpec(raw, 'member'));
  if (memberSpecs.length === 0)
    throw new UsageError('name at least one --member <agent>[@<version>]');
  if (memberSpecs.length > AGENT_TEAM_MEMBERS_MAX) {
    throw new UsageError(`a team has at most ${String(AGENT_TEAM_MEMBERS_MAX)} members`);
  }
  if (leadRaw === undefined && fallbackLead === null) {
    throw new UsageError('name the lead with --lead <agent>[@<version>]');
  }
  const specs =
    leadRaw === undefined ? memberSpecs : [parseMemberSpec(leadRaw, 'lead'), ...memberSpecs];
  const pins = await pinsOf(context, specs);
  const lead = leadRaw === undefined ? fallbackLead : pins[0];
  if (lead === null || lead === undefined) throw new UsageError('name the lead with --lead');
  const memberPins = leadRaw === undefined ? pins : pins.slice(1);
  return {
    lead,
    members: memberSpecs.map((spec, index) => {
      const pin = memberPins[index];
      if (pin === undefined) throw new Error('a member pin was not resolved');
      return spec.name === undefined ? pin : { ...pin, name: spec.name };
    }),
  };
}

/** A version as one table row: the lead's agent id and the member names. */
function versionRow(version: AgentTeamVersion) {
  return {
    version: version.version,
    lead: version.lead.agentId,
    members: version.members.map((member) => member.name).join(', '),
    createdAt: version.createdAt,
  };
}

/**
 * `aw agent-teams` — ADR-0104 (accepted for `handoff` mode), issue #1516, spec 04 §5.18 and §7.2.
 * A team is named by its exact name or its id; an agent by its name or id, pinned at
 * `<agent>@<version>` or, without a version, at the version `local` points at.
 */
export const agentTeamCommands: readonly Command[] = [
  command(
    'agent-teams list',
    '',
    "Every agent team of the workspace, with its newest version's lead and members",
    async (context) => {
      const teams: AgentTeamResource[] = [];
      for await (const team of context.client.agentTeams.listAll({}, { signal: context.signal })) {
        teams.push(team);
      }
      if (context.mode.json || context.mode.jsonl) return { value: teams };
      return {
        value: teams.map((team) => ({
          id: team.id,
          name: team.name,
          ...(team.latestVersion === null
            ? { version: '—', lead: '—', members: '—' }
            : versionRow(team.latestVersion)),
          createdAt: team.createdAt,
        })),
        columns: TEAM_COLUMNS,
      };
    },
  ),
  command(
    'agent-teams get',
    '<team>',
    'One agent team with its newest version',
    async (context) => ({
      value: await teamNamed(context, positional(context, 0, 'team')),
    }),
  ),
  command(
    'agent-teams create',
    '<name> [--description <text>] [--lead <agent>[@<version>] --member [<name>=]<agent>[@<version>] …]',
    'Create an agent team; with --lead and --member, its version 1 too',
    async (context) => {
      const name = positional(context, 0, 'name');
      const description = value(context, 'description');
      const withVersion =
        value(context, 'lead') !== undefined || values(context, 'member').length > 0;
      const team = await context.client.agentTeams.create(
        {
          name,
          ...(description === undefined ? {} : { description }),
          ...(withVersion ? { version: await versionRequest(context, null) } : {}),
        },
        { signal: context.signal },
      );
      return { value: team };
    },
  ),
  command(
    'agent-teams remove',
    '<team>',
    'Delete an agent team; its name is free again',
    async (context) => {
      const team = await teamNamed(context, positional(context, 0, 'team'));
      await context.client.agentTeams.remove(team.id, { signal: context.signal });
      return { value: undefined };
    },
  ),
  command(
    'agent-teams versions create',
    '<team> [--lead <agent>[@<version>]] --member [<name>=]<agent>[@<version>] …',
    "Save a team's next version; the lead stays the current one unless --lead names another",
    async (context) => {
      const team = await teamNamed(context, positional(context, 0, 'team'));
      const request = await versionRequest(context, team.latestVersion?.lead ?? null);
      return {
        value: await context.client.agentTeams.versions.create(team.id, request, {
          signal: context.signal,
        }),
      };
    },
  ),
  command(
    'agent-teams run',
    '<team> <prompt> [--session <id>] [--idempotency-key <key>] [--wait|--follow] [--fail-on-error]',
    "Run an agent team: its newest version's lead starts and calls the members as tools",
    async (context) => {
      const delivery = startDeliveryOf(context);
      const team = await teamNamed(context, positional(context, 0, 'team'));
      const prompt = positional(context, 1, 'prompt');
      if (prompt.trim() === '') throw new UsageError('the prompt must not be empty');
      const started = await context.client.agentTeams.run(
        team.id,
        {
          prompt,
          sessionId: value(context, 'session') ?? null,
          ...idempotencyKeyOf(context),
        },
        { signal: context.signal },
      );
      return deliverStarted(context, delivery, started.run);
    },
  ),
  command(
    'agent-teams versions list',
    '<team>',
    "A team's versions, newest first, with each one's lead and members",
    async (context) => {
      const team = await teamNamed(context, positional(context, 0, 'team'));
      const versions: AgentTeamVersion[] = [];
      let cursor: string | undefined;
      do {
        const page = await context.client.agentTeams.versions.list(
          team.id,
          cursor === undefined ? {} : { cursor },
          { signal: context.signal },
        );
        versions.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      if (context.mode.json || context.mode.jsonl) return { value: versions };
      return { value: versions.map(versionRow), columns: VERSION_COLUMNS };
    },
  ),
];
