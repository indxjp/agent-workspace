import messageChannel from '../../../channels/message';
import message from '../../../resources/message';
import { onDesk } from '../../../server/desk';
import { resourceRoutes } from '@indx-workspace/app/server';

const routes = resourceRoutes(message, { publish: messageChannel });

export const GET = onDesk(routes.GET);
export const POST = onDesk(routes.POST);
