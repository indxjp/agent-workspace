import messageChannel from '../../../../../channels/message';
import { onDesk } from '../../../../../server/desk';

const routes = messageChannel.routes();

export const GET = onDesk(routes.GET);
