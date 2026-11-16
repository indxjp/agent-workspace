import room from '../../../resources/room';
import { onDesk } from '../../../server/desk';
import { resourceRoutes } from '@indx-workspace/app/server';

const routes = resourceRoutes(room);

export const GET = onDesk(routes.GET);
export const POST = onDesk(routes.POST);
