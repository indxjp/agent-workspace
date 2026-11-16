import { createAgentRunResourceLoader, type ProjectResourceReader } from './resource-loader';

export function createRequestBodyFixture() {
  function noProjectResourceLoader(projectResources: ProjectResourceReader) {
    return createAgentRunResourceLoader({
      catalog: { forWorkspace: () => Promise.reject(new Error('unused')) },
      projectResources,
    });
  }
  const PORTABLE = { skills: { mode: 'all' }, limits: { maxTurns: null, maxBudgetUsd: null } };
  return { noProjectResourceLoader, PORTABLE };
}
