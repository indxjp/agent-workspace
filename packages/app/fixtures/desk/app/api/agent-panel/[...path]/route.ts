import page from '../../../../resources/page';
import ticket from '../../../../resources/ticket';
import { DESK_AGENTS, onDesk } from '../../../../server/desk';
import { agentPanelRoutes } from '@indx-workspace/app/server';

const routes = agentPanelRoutes({ resources: [ticket, page], agents: DESK_AGENTS });

export const GET = onDesk(routes.GET);
export const POST = onDesk(routes.POST);
