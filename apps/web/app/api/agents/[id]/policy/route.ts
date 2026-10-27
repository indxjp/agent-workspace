/** `GET`/`PUT /api/agents/:id/policy` (S-13); the use cases are `server/agents/policy-update.ts`. */
import { getAgentPolicy, updateAgentPolicy } from '../../../../../server/agents/policy-update';
import { route } from '../../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route({ component: 'agents', operation: 'get-policy' }, getAgentPolicy);

export const PUT = route({ component: 'agents', operation: 'update-policy' }, updateAgentPolicy);
