import app from '../../../../../../../../app.config';
import { deskRecipeRunner, onDesk } from '../../../../../../../../server/desk';
import { recipeRoutes } from '@indx-workspace/app/server';

export const POST = onDesk(recipeRoutes(app, { runner: deskRecipeRunner }).decision.POST);
