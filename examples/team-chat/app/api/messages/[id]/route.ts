import message from '@/resources/message';
import { resourceItemRoutes } from '@indx-workspace/app/server';
import messageChannel from '@/channels/message';
export const { GET, PATCH, DELETE } = resourceItemRoutes(message, { publish: messageChannel });
