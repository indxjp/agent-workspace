/**
 * W9-TEAM-121 · workspace invitations — issue #121.
 *
 * `invitations` postdates spec §34 entirely, so every declaration here carries a `mandate`. Each
 * cites §21, the same section `W2-CP-06.ts`'s `/api/memberships` entries cite:
 * an invitation is how §21's "Users belong to a workspace" happens for an identity that is not yet
 * a `users` row this deployment recognises, one step earlier than `POST /api/memberships`.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/invitations',
    owner: 'W9-TEAM-121',
    landed: true,
    mandate: {
      section: '21',
      because:
        'Users belong to a workspace with one of four roles; an invitation is how that membership is offered before it is a fact, and an Owner/Admin administering it needs to see the ones still pending.',
    },
  },
  {
    method: 'POST',
    path: '/api/invitations',
    owner: 'W9-TEAM-121',
    landed: true,
    mandate: {
      section: '21',
      because:
        "Attaching a not-yet-a-member identity to a workspace with a role is §21's membership grant, offered rather than attached directly — the same capability `POST /api/memberships` cites §21 for, one step earlier.",
    },
  },
  {
    method: 'POST',
    path: '/api/invitations/:id/resend',
    owner: 'W9-TEAM-121',
    landed: true,
    mandate: {
      section: '21',
      because:
        'A single-use, expiring token that never reaches its recipient is not a membership offer any more; resending is administering the same §21 grant `POST /api/invitations` made.',
    },
  },
  {
    method: 'DELETE',
    path: '/api/invitations/:id',
    owner: 'W9-TEAM-121',
    landed: true,
    mandate: {
      section: '21',
      because:
        'Withdrawing a membership offer before it is accepted is the same administrative act `DELETE /api/memberships/:id` is after acceptance, over the same §21 grant.',
    },
  },
  {
    method: 'POST',
    path: '/api/invitations/:id/accept',
    owner: 'W9-TEAM-121',
    landed: true,
    mandate: {
      section: '21',
      because:
        "Redeeming the offer is the moment §21's membership actually forms; without this route the invitation the three routes above create and administer could never become one.",
    },
  },
];
