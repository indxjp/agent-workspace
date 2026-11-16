import type { SetupPersistenceContext } from './setup-persist';
export const SETUP_AGENT_PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
} as const;
type AgentContext = Pick<
  SetupPersistenceContext,
  'root' | 'scope' | 'input' | 'member' | 'seededModel' | 'undo'
>;
type SetupAgents = ReturnType<SetupPersistenceContext['root']['agents']['forScope']>;
function setupAgentDefinition(
  context: Pick<AgentContext, 'input' | 'seededModel'>,
  connectionId: string,
  profileId: string,
) {
  const { input, seededModel } = context;
  return {
    instructions: input.agentInstructions,
    modelConnectionId: connectionId,
    model: seededModel,
    runtimeProfileId: profileId,
    permissions: SETUP_AGENT_PERMISSIONS,
  } as const;
}
type AgentWriteContext = {
  readonly agentRepository: SetupAgents;
  readonly agentName: string;
  readonly definition: ReturnType<typeof setupAgentDefinition>;
  readonly member: AgentContext['member'];
  readonly undo: AgentContext['undo'];
};
export async function persistFirstAgent(
  context: AgentContext,
  connectionId: string,
  profileId: string,
) {
  const { root, scope, input, member, undo } = context;
  const agentRepository = root.agents.forScope(scope);
  const agentName = input.agentName.trim();
  const existingAgents = await agentRepository.list();
  const existingAgent = existingAgents.find(
    (entry) => entry.name === agentName && entry.builtin === undefined,
  );
  const definition = setupAgentDefinition(context, connectionId, profileId);
  const write = { agentRepository, agentName, definition, member, undo };
  const written =
    existingAgent === undefined
      ? await createSetupAgent(write)
      : await updateSetupAgent(write, existingAgent);
  if (!written.ok) return written;
  return { ok: true as const, agentId: written.agentId, agentRepository, existingAgents };
}
async function createSetupAgent({
  agentRepository,
  agentName,
  definition,
  member,
  undo,
}: AgentWriteContext) {
  // issue #117: every create path stamps `created_by`; first-run setup attributes the
  // default agent to the bootstrap administrator whose membership this request just verified.
  const created = await agentRepository.create({
    name: agentName,
    ...definition,
    ownerPrincipalId: member.principalId,
    createdBy: member.userId,
  });
  if (created.kind !== 'created')
    return {
      ok: false as const,
      status: 409,
      code: created.kind,
      message: 'The first agent could not be created.',
    };
  const createdId = created.agent.id;

  undo.push({
    label: `delete agent ${createdId}`,
    run: async () => (await agentRepository.delete(createdId)).kind === 'deleted',
  });
  return { ok: true as const, agentId: createdId };
}
async function updateSetupAgent(
  { agentRepository, definition, undo }: AgentWriteContext,
  existingAgent: Awaited<ReturnType<SetupAgents['list']>>[number],
) {
  const existingId = existingAgent.id;

  const updated = await agentRepository.update(existingId, definition);
  if (updated.kind !== 'updated')
    return {
      ok: false as const,
      status: 409,
      code: updated.kind,
      message: 'The existing first agent could not be updated.',
    };
  const previous: Parameters<SetupAgents['update']>[1] = {
    instructions: existingAgent.instructions,
    modelConnectionId: existingAgent.modelConnectionId,
    model: existingAgent.model,
    runtimeProfileId: existingAgent.runtimeProfileId,
    permissions: existingAgent.permissions,
  };
  undo.push({
    label: `restore agent ${existingId}`,
    run: async () => (await agentRepository.update(existingId, previous)).kind === 'updated',
  });
  return { ok: true as const, agentId: existingId };
}
