import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

/** The desk's agents, by the name `agents/<name>.ts` defines. */
export type DeskAgent = 'triage' | 'closer';

// shortcut: `aw dev` and `aw deploy` hand the app no agent ids, so an agent is found by name with
// the app key unless AW_<NAME>_AGENT_ID names it; upgrade when the app is given its agents' ids.
let found: Promise<ReadonlyMap<string, string>> | undefined;

/** The Agent Workspace id of the desk agent `name`. */
export async function agentIdOf(
  aw: Pick<AgentWorkspaceClient, 'agents'>,
  name: DeskAgent,
): Promise<string> {
  const configured = process.env[`AW_${name.toUpperCase()}_AGENT_ID`];
  if (configured !== undefined && configured !== '') return configured;
  found ??= aw.agents.list().then((agents) => new Map(agents.map((a) => [a.name, a.id])));
  const id = await found.catch((error: unknown) => {
    found = undefined;
    throw error;
  });
  const agent = id.get(name);
  if (agent === undefined) {
    found = undefined;
    throw new Error(`no agent named ${name} in this workspace`);
  }
  return agent;
}
