import page from '@/resources/page';
import { agentPanelRoutes, appRuntime, type AgentPanelHandler } from '@indx-workspace/app/server';
import { createClient } from '@indx-workspace/sdk';

/** The agent the page's panel offers (agents/writer.ts). */
const WRITER = 'writer';

// shortcut: `aw dev` and `aw deploy` hand the app no agent ids, so the writer is found by name
// with the app's key on each request; upgrade when the app is given its agents' ids.
async function routes() {
  const apiKey = process.env['AW_APP_API_KEY'] ?? '';
  const aw = createClient({ baseUrl: appRuntime().awUrl, auth: { kind: 'api-key', apiKey } });
  const id = (await aw.agents.list()).find((agent) => agent.name === WRITER)?.id;
  // The panel beside each page; an agent not found is answered `agent_panel_misconfigured`.
  return agentPanelRoutes({ resources: [page], agents: { [WRITER]: id } });
}

export const GET: AgentPanelHandler = async (request, context) =>
  (await routes()).GET(request, context);
export const POST: AgentPanelHandler = async (request, context) =>
  (await routes()).POST(request, context);
