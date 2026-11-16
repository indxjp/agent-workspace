// Starts one slot of a schedule recipe at a chosen instant, so a journey can move a record past
// a deadline. An Owner or Admin only; it answers 404 under NODE_ENV=production (next start).
import app from '@/app.config';
import { recipeRoutes } from '@indx-workspace/app/server';
export const { POST } = recipeRoutes(app).slots;
