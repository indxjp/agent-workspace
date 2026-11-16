import crypto from 'node:crypto';
import { mintSessionToken, newSessionClaims, verifySessionToken } from '../auth/session';
import { Principal } from '../rbac/principal';
import { installRbacHarness, TEST_WORKSPACE_ID } from '../rbac/testing';
export const MEMBERS = [
  {
    email: 'owner@example.test',
    name: 'Owner',
    workspaceId: TEST_WORKSPACE_ID,
    role: 'owner' as const,
  },
  {
    email: 'admin@example.test',
    name: 'Admin',
    workspaceId: TEST_WORKSPACE_ID,
    role: 'admin' as const,
  },
  {
    email: 'builder@example.test',
    name: 'Builder',
    workspaceId: TEST_WORKSPACE_ID,
    role: 'builder' as const,
  },
  {
    email: 'viewer@example.test',
    name: 'Viewer',
    workspaceId: TEST_WORKSPACE_ID,
    role: 'viewer' as const,
  },
];

export const TEST_SESSION_SECRET = 'invitation-session-secret-that-is-long-enough';

export const IDENTITY_ISSUER = 'https://issuer.example.test';

export function installInvitationHarness() {
  return installRbacHarness(MEMBERS, { newId: crypto.randomUUID });
}

export async function sessionPrincipal(email: string, role: 'admin'): Promise<Principal> {
  const token = await mintSessionToken(newSessionClaims(email, 'default'), TEST_SESSION_SECRET);
  const verified = await verifySessionToken(token, TEST_SESSION_SECRET);
  if (!verified.ok) throw new Error(`test session could not be verified: ${verified.reason}`);
  const built = Principal.fromSession(
    verified.claims,
    { id: TEST_WORKSPACE_ID, slug: 'default' },
    role,
    {
      principalId: '2218cf6d-4c5f-42e9-9276-237504501564',
      userId: 'bb5a45b9-415a-484a-b4d7-b3d1713d7cb6',
      label: 'Removed invitation administrator',
    },
  );
  if (!built.ok) throw new Error(`test principal could not be built: ${built.because}`);
  return built.principal;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

export function invitationCreation(body: unknown): { id: string; token: string; link: string } {
  const response = record(body);
  const invitation = record(response['invitation']);
  const id = invitation['id'];
  const token = response['token'];
  const link = response['link'];
  if (typeof id !== 'string' || typeof token !== 'string' || typeof link !== 'string') {
    throw new Error(`creation response omitted its one-time fields: ${JSON.stringify(body)}`);
  }
  return { id, token, link };
}

export function setCookieValue(response: Response, name: string): string | undefined {
  for (const cookie of response.headers.getSetCookie()) {
    if (cookie.startsWith(`${name}=`)) return cookie.slice(name.length + 1).split(';')[0];
  }
  return undefined;
}
