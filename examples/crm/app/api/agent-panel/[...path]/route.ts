import { AGENT } from '@/recipes/enrich-contact';
import deal from '@/resources/deal';
import { agentPanelRoutes, appRuntime, type AgentPanelHandler } from '@indx-workspace/app/server';
import { createClient } from '@indx-workspace/sdk';

// shortcut: `aw dev` and `aw deploy` hand the app no agent ids, so the sales assistant is found by
// name with the app's key on each request; upgrade when the app is given its agents' ids.
async function routes() {
  const apiKey = process.env['AW_APP_API_KEY'] ?? '';
  const aw = createClient({ baseUrl: appRuntime().awUrl, auth: { kind: 'api-key', apiKey } });
  const id = (await aw.agents.list()).find((agent) => agent.name === AGENT)?.id;
  // The panel beside each deal; an agent not found is answered `agent_panel_misconfigured`.
  return agentPanelRoutes({ resources: [deal], agents: { [AGENT]: id } });
}

export const GET: AgentPanelHandler = async (request, context) =>
  (await routes()).GET(request, context);
export const POST: AgentPanelHandler = async (request, context) =>
  (await routes()).POST(request, context);
