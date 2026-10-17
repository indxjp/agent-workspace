export interface AgentDefinitionInput {
  readonly name: string;
  readonly instructions: string;
  readonly modelConnectionName?: string;
  readonly connectorNames?: readonly string[];
  readonly fileCount?: number;
  readonly [key: string]: unknown;
}
export interface AgentDefinitionExport {
  readonly definition: Record<string, unknown>;
  readonly requirements: readonly string[];
}
export function exportAgentDefinition(
  agent: AgentDefinitionInput,
  secretValues: readonly string[],
  secretReferenceIds: readonly string[],
): AgentDefinitionExport {
  const forbidden = [...secretValues, ...secretReferenceIds].filter(Boolean);
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let out = value;
      for (const item of forbidden) out = out.split(item).join('{{REQUIRED_SECRET}}');
      return out;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !/credential|secret|environment/i.test(key))
          .map(([key, item]) => [key, clean(item)]),
      );
    return value;
  };
  const requirements: string[] = [];
  if (agent.modelConnectionName)
    requirements.push('a model connection (any Claude-capable provider)');
  for (const name of agent.connectorNames ?? [])
    requirements.push(`connector "${name}" (you will be asked for your own credentials)`);
  if ((agent.fileCount ?? 0) > 0)
    requirements.push(`${agent.fileCount} files (not included in this share)`);
  return { definition: clean(agent) as Record<string, unknown>, requirements };
}
export function missingRequirements(
  exported: AgentDefinitionExport,
  supplied: readonly string[],
): readonly string[] {
  return exported.requirements.filter((requirement) => !supplied.includes(requirement));
}
