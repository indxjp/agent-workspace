// GET /api/sign-in?next=: starts the person's sign-in at the app's OpenID Connect issuer (ADR-0161).
import { signInRoutes } from '@indx-workspace/app/server';

export const GET = signInRoutes().start;
