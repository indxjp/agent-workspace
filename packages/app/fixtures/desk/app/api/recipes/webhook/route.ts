import app from '../../../../app.config';
import { deskRecipeRunner, onDesk } from '../../../../server/desk';
import { recipeRoutes } from '@indx-workspace/app/server';

/** The desk has no webhook secret, so this answers `503 recipes_unavailable`; polling advances it. */
export const POST = onDesk(recipeRoutes(app, { runner: deskRecipeRunner }).webhook.POST);
