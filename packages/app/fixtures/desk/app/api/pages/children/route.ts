import page from '../../../../resources/page';
import { onDesk } from '../../../../server/desk';
import { pageRoutes } from '@indx-workspace/app/server';

export const GET = onDesk(pageRoutes(page).children.GET);
