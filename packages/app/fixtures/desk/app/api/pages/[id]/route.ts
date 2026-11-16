import page from '../../../../resources/page';
import { onDesk } from '../../../../server/desk';
import { resourceItemRoutes } from '@indx-workspace/app/server';

const routes = resourceItemRoutes(page);

export const GET = onDesk(routes.GET);
export const PATCH = onDesk(routes.PATCH);
export const DELETE = onDesk(routes.DELETE);
