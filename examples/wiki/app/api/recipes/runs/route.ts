import app from '@/app.config';
import { recipeRoutes } from '@indx-workspace/app/server';
export const { GET } = recipeRoutes(app).list;
