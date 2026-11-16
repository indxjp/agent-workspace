// POST /api/sign-out: forgets the signed-in person's token.
import { signInRoutes } from '@indx-workspace/app/server';

export const POST = signInRoutes().signOut;
