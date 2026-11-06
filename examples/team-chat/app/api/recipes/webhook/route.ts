// Run-outcome webhooks wake a recipe's waiting step. Until AW_APP_WEBHOOK_SECRET holds the
// `whsec_` secret Agent Workspace returned, this answers 503 and the runner follows each run.
import app from '@/app.config';
import { recipeRoutes } from '@indx-workspace/app/server';
export const { POST } = recipeRoutes(app).webhook;
