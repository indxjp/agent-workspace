import ticket from '@/resources/ticket';
import { agentIdOf, type DeskAgent } from '@/lib/agent-ids';
import { agentPanelRoutes, appRuntime, type AgentPanelHandler } from '@indx-workspace/app/server';
import { createClient } from '@indx-workspace/sdk';

/**
 * The panel's routes on each ticket, offering triage and closer. An agent not found yet is
 * `undefined`, which the panel answers as `agent_panel_misconfigured` (see lib/agent-ids.ts).
 */
async function routes() {
  const apiKey = process.env['AW_APP_API_KEY'] ?? '';
  const aw = createClient({ baseUrl: appRuntime().awUrl, auth: { kind: 'api-key', apiKey } });
  const idOf = (name: DeskAgent) => agentIdOf(aw, name).catch(() => undefined);
  const [triage, closer] = await Promise.all([idOf('triage'), idOf('closer')]);
  return agentPanelRoutes({ resources: [ticket], agents: { triage, closer } });
}

export const GET: AgentPanelHandler = async (request, context) =>
  (await routes()).GET(request, context);
export const POST: AgentPanelHandler = async (request, context) =>
  (await routes()).POST(request, context);
