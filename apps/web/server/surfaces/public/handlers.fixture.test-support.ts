import { afterEach } from 'vitest';
import { ApiProblemSchema } from '@indx-workspace/contracts';
import { type SurfaceSessionRequest } from '@indx-workspace/contracts/surfaces';
import { toResponse } from '../../rbac/http';
import { createSurfaceSession } from './handlers';
import { resetSurfaceLimits } from './limits';
import { type ResolvedSurface, type SurfaceSessionOpening } from './runtime';
import { installTestDomains } from '../../application-context-fixtures';
import { clearApplicationContext } from '../../application-context';

export const LOCAL_ENV = { AW_LOCAL_SURFACE_SESSIONS: '1', HOST: '127.0.0.1' } as const;

export const SAME_ORIGIN = {
  host: '127.0.0.1:4310',
  origin: 'http://127.0.0.1:4310',
  'sec-fetch-site': 'same-origin',
} as const;

export const TOKEN = `awt_live_${'a'.repeat(22)}_${'b'.repeat(43)}`;

export const SESSION_ID = '11111111-1111-4111-8111-111111111111';

export const AGENT_ID = '22222222-2222-4222-8222-222222222222';

export const OTHER_AGENT_ID = '44444444-4444-4444-8444-444444444444';

export const RESUME_KEY = 'k'.repeat(43);

export const EXPIRES_AT = new Date('2026-10-02T11:00:00.000Z');

export const FRAME_ANCESTORS = "frame-ancestors 'self'";

export const RESOLVED: ResolvedSurface = {
  workspaceId: '33333333-3333-4333-8333-333333333333',
  agentId: AGENT_ID,
  agentName: 'Support triage',
  environment: 'local',
  versionId: '55555555-5555-4555-8555-555555555555',
  versionNumber: 2,
  promoted: false,
  surface: { name: 'main', agent: 'Support triage' },
};

export interface FakeRuntimeCalls {
  readonly resolved: string[];
  readonly opened: ResolvedSurface[];
  readonly requests: SurfaceSessionRequest[];
}

export function createSurfaceRuntimeInstaller(
  readEnvironment: () => Readonly<Record<string, string | undefined>>,
) {
  function install(
    resolved: ResolvedSurface | null,
    opening: SurfaceSessionOpening = {
      kind: 'opened',
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      token: TOKEN,
      expiresAt: EXPIRES_AT,
      resumeKey: RESUME_KEY,
    },
    env: () => Readonly<Record<string, string | undefined>> = readEnvironment,
  ): FakeRuntimeCalls {
    const calls: FakeRuntimeCalls = { resolved: [], opened: [], requests: [] };
    installTestDomains({
      surfaces: {
        kind: 'serving',
        runtime: {
          env,
          resolve: (name, mode) => {
            calls.resolved.push(mode === 'public' ? name : `${name} (${mode})`);
            return Promise.resolve(resolved);
          },
          open: (surface, options) => {
            calls.opened.push(surface);
            calls.requests.push(options);
            return Promise.resolve(opening);
          },
          checkModel: () => Promise.reject(new Error('the bootstrap never checks a model alone')),
          visitorSurface: () => Promise.reject(new Error('the bootstrap never looks a session up')),
          servedSurfaces: () => Promise.resolve(resolved === null ? [] : [resolved.surface]),
        },
      },
    });
    return calls;
  }

  return install;
}
export type SurfaceRuntimeInstaller = ReturnType<typeof createSurfaceRuntimeInstaller>;

export function request(
  values: Readonly<Record<string, string>> = SAME_ORIGIN,
  body?: BodyInit,
  url = 'http://127.0.0.1:4310/p/s/main/sessions',
): Request {
  return new Request(url, {
    method: 'POST',
    headers: values,
    ...(body === undefined ? {} : { body }),
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } satisfies RequestInit & { duplex?: 'half' });
}

export async function answer(
  name: string,
  input: Request = request(),
  env: Readonly<Record<string, string>> = LOCAL_ENV,
): Promise<{ status: number; body: unknown; response: Response }> {
  const response = toResponse(await createSurfaceSession(input, name, env));
  const body: unknown = await response.clone().json();
  return { status: response.status, body, response };
}

export function codeOf(body: unknown): string {
  return ApiProblemSchema.parse(body).error.code;
}

afterEach(() => {
  clearApplicationContext();
  resetSurfaceLimits();
});
