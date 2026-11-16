import messageChannel from '../../../../channels/message';
import message from '../../../../resources/message';
import { onDesk } from '../../../../server/desk';
import { resourceItemRoutes } from '@indx-workspace/app/server';

const routes = resourceItemRoutes(message, { publish: messageChannel });

export const GET = onDesk(routes.GET);
export const PATCH = onDesk(routes.PATCH);
export const DELETE = onDesk(routes.DELETE);
