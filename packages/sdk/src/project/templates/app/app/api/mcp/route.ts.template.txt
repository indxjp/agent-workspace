import app from '@/app.config';
import { mcpEndpoint } from '@indx-workspace/app/server';

export const { POST, GET, DELETE } = mcpEndpoint(app);
