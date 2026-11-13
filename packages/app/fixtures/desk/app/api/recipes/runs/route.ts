import app from '../../../../app.config';
import { deskRecipeRunner, onDesk } from '../../../../server/desk';
import { recipeRoutes } from '@indx-workspace/app/server';

export const GET = onDesk(recipeRoutes(app, { runner: deskRecipeRunner }).list.GET);
