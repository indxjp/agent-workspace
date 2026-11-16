import ticket_comment from '@/resources/ticket_comment';
import { resourceItemRoutes } from '@indx-workspace/app/server';
export const { GET, PATCH, DELETE } = resourceItemRoutes(ticket_comment);
