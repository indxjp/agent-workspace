import ticket from '../../../resources/ticket';
import { onDesk } from '../../../server/desk';
import { resourceRoutes } from '@indx-workspace/app/server';

const routes = resourceRoutes(ticket);

export const GET = onDesk(routes.GET);
export const POST = onDesk(routes.POST);
