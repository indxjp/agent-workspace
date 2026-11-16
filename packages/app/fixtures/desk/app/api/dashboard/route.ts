import { onDesk } from '../../../server/desk';
import { dashboardRoutes } from '@indx-workspace/app/server';

export const GET = onDesk(dashboardRoutes().GET);
