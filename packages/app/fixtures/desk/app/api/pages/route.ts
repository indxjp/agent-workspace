import page from '../../../resources/page';
import { onDesk } from '../../../server/desk';
import { resourceRoutes } from '@indx-workspace/app/server';

const routes = resourceRoutes(page);

export const GET = onDesk(routes.GET);
export const POST = onDesk(routes.POST);
