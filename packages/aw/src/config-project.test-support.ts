import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll } from 'vitest';

import { profilesFilePath } from './config.js';
import { resolve, homeWithProfiles } from './config.fixture.test-support.js';
import { saveStoredCredential } from './credentials.js';

export const TOKEN = `awu_live_${'A'.repeat(22)}_${'S'.repeat(43)}`;
export const LOCAL_URL = 'http://127.0.0.1:3000';
export const FAR_FUTURE = '2999-01-01T00:00:00.000Z';
/** The workspace identity every stored local credential in these tests carries. */
export const LOCAL_ENTRY = {
  workspaceId: '44444444-4444-4444-8444-444444444444',
  workspaceSlug: 'local',
} as const;

export const v2 = (port?: number): string =>
  [
    'apiVersion: agentworkspace.dev/v2',
    'kind: Project',
    'name: demo',
    'environments:',
    '  local:',
    '    cloud: local',
    '    identity:',
    '      bootstrapAdmin: admin@localhost.test',
    ...(port === undefined ? [] : [`    port: ${String(port)}`]),
    '',
  ].join('\n');

const V1 = [
  'apiVersion: agentworkspace.dev/v1',
  'kind: Deployment',
  'cloud: local',
  'storage:',
  '  relational: compose',
  '  objects: compose',
  '  secrets: compose',
  'runtime:',
  '  default: docker',
  'identity:',
  '  bootstrapAdmin: admin@localhost.test',
  '',
].join('\n');

/** The temporary project directories and homes, filled in by the `beforeAll` below. */
export const fixtures = {
  root: '',
  projectDefault: '',
  projectPort: '',
  projectV1: '',
  projectBroken: '',
  noProject: '',
  homeWithToken: '',
};

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aw-config-project-'));
  Object.assign(fixtures, {
    root,
    projectDefault: path.join(root, 'default'),
    projectPort: path.join(root, 'port'),
    projectV1: path.join(root, 'v1'),
    projectBroken: path.join(root, 'broken'),
    noProject: path.join(root, 'none'),
    homeWithToken: path.join(root, 'home'),
  });
  for (const [directory, text] of [
    [fixtures.projectDefault, v2()],
    [fixtures.projectPort, v2(4123)],
    [fixtures.projectV1, V1],
    [fixtures.projectBroken, `${v2()}    surprise: true\n`],
  ] as const) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'agent-workspace.yaml'), text);
  }
  await mkdir(fixtures.noProject, { recursive: true });
  await mkdir(path.dirname(profilesFilePath(fixtures.homeWithToken)), { recursive: true });
  await writeFile(
    profilesFilePath(fixtures.homeWithToken),
    JSON.stringify({ default: { url: 'https://default.example.com', apiKeyRef: 'DEFAULT_KEY' } }),
  );
  await saveStoredCredential(fixtures.homeWithToken, LOCAL_URL, {
    ...LOCAL_ENTRY,
    token: TOKEN,
    expiresAt: FAR_FUTURE,
  });
});

afterAll(async () => {
  await rm(fixtures.root, { recursive: true, force: true });
});

export function resolveProjectConfig(
  input: Partial<Parameters<typeof resolve>[0]> & { readonly cwd: string },
) {
  return resolve({ argv: [], env: {}, homeDir: homeWithProfiles, stdin: '', ...input });
}
