import type { ApiRoute } from './definition.js';
import { created, json, NO_CONTENT, ok, UNDESCRIBED } from './definition.js';
export const teamRoutes: readonly ApiRoute[] = [
  // §5.2 — principals
  {
    method: 'GET',
    path: '/api/memberships',
    operationId: 'team.members.list',
    tag: 'team',
    feature: 'core',
    summary: 'List the members of the workspace',
    success: ok(json('MembershipListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/memberships',
    operationId: 'team.members.add',
    tag: 'team',
    feature: 'core',
    summary: 'Add a user to the workspace',
    request: UNDESCRIBED,
    success: created(json('MembershipResponseSchema')),
  },

  {
    method: 'PATCH',
    path: '/api/memberships/:id',
    operationId: 'team.members.setRole',
    tag: 'team',
    feature: 'core',
    summary: "Change a member's role",
    request: UNDESCRIBED,
    success: ok(json('MembershipResponseSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/memberships/:id',
    operationId: 'team.members.remove',
    tag: 'team',
    feature: 'core',
    summary: 'Remove a member',
    success: NO_CONTENT,
  },

  {
    method: 'GET',
    path: '/api/users',
    operationId: 'team.users.list',
    tag: 'team',
    feature: 'core',
    summary: 'List users',
    success: ok(json('UserListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/users',
    operationId: 'team.users.create',
    tag: 'team',
    feature: 'core',
    summary: 'Create a user',
    request: UNDESCRIBED,
    success: created(json('CreatedUserResponseSchema')),
  },

  {
    method: 'GET',
    path: '/api/invitations',
    operationId: 'team.invitations.list',
    tag: 'team',
    feature: 'core',
    summary: 'List invitations',
    success: ok(json('InvitationListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/invitations',
    operationId: 'team.invitations.create',
    tag: 'team',
    feature: 'core',
    summary: 'Invite someone to the workspace',
    request: UNDESCRIBED,
    success: created(json('IssuedInvitationResponseSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/invitations/:id',
    operationId: 'team.invitations.revoke',
    tag: 'team',
    feature: 'core',
    summary: 'Revoke an invitation',
    success: ok(json('InvitationResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/invitations/:id/resend',
    operationId: 'team.invitations.resend',
    tag: 'team',
    feature: 'core',
    summary: 'Re-issue an invitation',
    success: ok(json('IssuedInvitationResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/invitations/:id/accept',
    operationId: 'team.invitations.accept',
    tag: 'team',
    feature: 'core',
    summary: 'Accept an invitation',
    request: UNDESCRIBED,
    success: ok(json('AcceptedInvitationResponseSchema')),
    security: 'invitation-identity',
  },

  {
    method: 'GET',
    path: '/api/api-keys',
    operationId: 'team.apiKeys.list',
    tag: 'team',
    feature: 'core',
    summary: 'List API keys',
    success: ok(json('ApiKeyListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/api-keys',
    operationId: 'team.apiKeys.create',
    tag: 'team',
    feature: 'core',
    summary: 'Mint an API key; the secret is returned once',
    request: UNDESCRIBED,
    success: created(json('MintedApiKeyResponseSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/api-keys/:id',
    operationId: 'team.apiKeys.revoke',
    tag: 'team',
    feature: 'core',
    summary: 'Revoke an API key',
    success: ok(json('ApiKeyResponseSchema')),
  },
];
