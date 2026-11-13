// GET /api/sign-in/callback: trades the issuer's answer for the person's own Agent Workspace token.
import { signInRoutes } from '@indx-workspace/app/server';

export const GET = signInRoutes().callback;
