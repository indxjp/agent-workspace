import message from '@/resources/message';
import { resourceRoutes } from '@indx-workspace/app/server';
import messageChannel from '@/channels/message';
export const { GET, POST } = resourceRoutes(message, { publish: messageChannel });
