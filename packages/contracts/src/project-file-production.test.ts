import { expect, it } from 'vitest';

import {
  appSchemaName,
  PROJECT_DEPLOY_TARGETS,
  ProjectDocumentSchema,
  readProjectDocument,
} from './project-file.js';

import { minimal, refusedPaths } from './project-file.fixture.test-support.js';

const withProduction = (production: unknown): unknown => ({
  ...minimal,
  environments: { ...minimal.environments, production },
});
const demo = { target: 'single-vm', url: 'https://agents.example.com' };

it('accepts the demo file, for each deploy target', () => {
  for (const target of PROJECT_DEPLOY_TARGETS) {
    const document = withProduction({ ...demo, target });
    expect(ProjectDocumentSchema.parse(document)).toEqual(document);
  }
});

it('refuses an unknown target at environments.production.target', () => {
  expect(
    refusedPaths(ProjectDocumentSchema.safeParse(withProduction({ ...demo, target: 'aws' }))),
  ).toEqual([['environments', 'production', 'target']]);
});

it.each([
  'http://agents.example.com',
  'https://owner:hunter2@agents.example.com',
  'https://agents.example.com/?token=hunter2',
  'https://agents.example.com/app',
  'https://agents.example.com/#top',
  'agents.example.com',
])('refuses the url %s at environments.production.url', (url) => {
  const result = ProjectDocumentSchema.safeParse(withProduction({ ...demo, url }));
  expect(refusedPaths(result)).toEqual([['environments', 'production', 'url']]);
  expect(result.error?.issues.map((issue) => issue.message).join('\n')).not.toContain('hunter2');
});

it('accepts a trailing slash, which names the same origin', () => {
  const document = withProduction({ ...demo, url: 'https://agents.example.com/' });
  expect(ProjectDocumentSchema.safeParse(document).success).toBe(true);
});

it.each(['cloud', 'storage', 'identity'])('refuses an extra %s key', (key) => {
  expect(
    refusedPaths(ProjectDocumentSchema.safeParse(withProduction({ ...demo, [key]: 'x' }))),
  ).toEqual([['environments', 'production', key]]);
});

it('refuses a production with no target or url', () => {
  expect(refusedPaths(ProjectDocumentSchema.safeParse(withProduction({})))).toEqual([
    ['environments', 'production', 'target'],
    ['environments', 'production', 'url'],
  ]);
});

it('still refuses preview beside production', () => {
  const document = {
    ...minimal,
    environments: { ...minimal.environments, production: demo, preview: demo },
  };
  expect(refusedPaths(ProjectDocumentSchema.safeParse(document))).toEqual([
    ['environments', 'preview'],
  ]);
});

it('reads a v2 file with production as written, not lifted', () => {
  const result = readProjectDocument(withProduction(demo));
  expect(result.success && result.data.lifted).toBe(false);
});

const gcp = { project: 'my-agents-123', region: 'asia-northeast1' };
const withGcp = (value: unknown, target = 'gcp-cloudrun'): unknown => ({
  ...minimal,
  environments: {
    ...minimal.environments,
    production: { target, url: 'https://agents.example.com', gcp: value },
  },
});

it('accepts a project and region under the gcp-cloudrun target', () => {
  const document = withGcp(gcp);
  expect(ProjectDocumentSchema.parse(document)).toEqual(document);
});

it.each(['europe-west10', 'europe-west12', 'me-central2'])(
  'accepts the region %s, whose number has one or two digits',
  (region) => {
    const document = withGcp({ ...gcp, region });
    expect(ProjectDocumentSchema.parse(document)).toEqual(document);
  },
);

it.each(['global', 'us', 'eu'])('accepts modelLocation %s', (modelLocation) => {
  const document = withGcp({ ...gcp, modelLocation });
  expect(ProjectDocumentSchema.parse(document)).toEqual(document);
});

it('refuses a modelLocation outside global, us and eu, at its own path', () => {
  expect(
    refusedPaths(ProjectDocumentSchema.safeParse(withGcp({ ...gcp, modelLocation: 'asia' }))),
  ).toEqual([['environments', 'production', 'gcp', 'modelLocation']]);
});

it('still accepts gcp-cloudrun with no gcp block', () => {
  const document = {
    ...minimal,
    environments: {
      ...minimal.environments,
      production: { target: 'gcp-cloudrun', url: 'https://agents.example.com' },
    },
  };
  expect(ProjectDocumentSchema.parse(document)).toEqual(document);
});

it('accepts a domain, armor, iap and an oidc block', () => {
  const document = withGcp({
    ...gcp,
    domain: 'agents.example.com',
    armor: true,
    iap: true,
    oidc: { issuer: 'https://accounts.example.com', clientId: 'client-1' },
  });
  expect(ProjectDocumentSchema.parse(document)).toEqual(document);
});

it.each([
  'https://agents.example.com',
  'agents.example.com:8443',
  'Agents.example.com',
  'agents',
  'a.com/x',
  'agents.example.c',
  'agents.example.xn--p1ai',
  'agents.example.c0m',
])('refuses the domain %s', (domain) => {
  expect(refusedPaths(ProjectDocumentSchema.safeParse(withGcp({ ...gcp, domain })))).toEqual([
    ['environments', 'production', 'gcp', 'domain'],
  ]);
});

it.each(['armor', 'iap'])('refuses %s: true without a domain', (key) => {
  const result = ProjectDocumentSchema.safeParse(withGcp({ ...gcp, [key]: true }));
  expect(refusedPaths(result)).toEqual([['environments', 'production', 'gcp', key]]);
  expect(JSON.stringify(result.error?.issues)).toContain('needs gcp.domain');
});

it('accepts armor: false without a domain', () => {
  const document = withGcp({ ...gcp, armor: false, iap: false });
  expect(ProjectDocumentSchema.parse(document)).toEqual(document);
});

it.each([
  { issuer: 'http://accounts.example.com', clientId: 'c' },
  { issuer: 'https://accounts.example.com', clientId: '' },
  { issuer: 'https://accounts.example.com', clientId: 'c', clientSecret: 'x' },
])('refuses the oidc block %j', (oidc) => {
  expect(ProjectDocumentSchema.safeParse(withGcp({ ...gcp, oidc })).success).toBe(false);
});

it('accepts a size, dataProtection and an alertsEmail', () => {
  const document = withGcp({
    ...gcp,
    size: 'standard',
    dataProtection: false,
    alertsEmail: 'ops@example.com',
  });
  expect(ProjectDocumentSchema.parse(document)).toEqual(document);
});

it.each([true, false])('accepts sandboxInternet: %s', (sandboxInternet) => {
  const document = withGcp({ ...gcp, sandboxInternet });
  expect(ProjectDocumentSchema.parse(document)).toEqual(document);
});

it.each([
  ['size', 'large'],
  ['alertsEmail', 'not-an-email'],
  ['dataProtection', 'no'],
  ['sandboxInternet', 'yes'],
])('refuses %s: %j at its own path', (key, value) => {
  expect(refusedPaths(ProjectDocumentSchema.safeParse(withGcp({ ...gcp, [key]: value })))).toEqual([
    ['environments', 'production', 'gcp', key],
  ]);
});

it('refuses an alertsEmail longer than 254 characters', () => {
  const alertsEmail = `${'a'.repeat(250)}@example.com`;
  expect(ProjectDocumentSchema.safeParse(withGcp({ ...gcp, alertsEmail })).success).toBe(false);
});

it('refuses an unknown key under gcp', () => {
  expect(refusedPaths(ProjectDocumentSchema.safeParse(withGcp({ ...gcp, zone: 'a' })))).toEqual([
    ['environments', 'production', 'gcp', 'zone'],
  ]);
});

it.each(['My-Project', 'abc', '1abcdef', 'abcde-'])(
  'refuses the project id %s at environments.production.gcp.project',
  (project) => {
    expect(refusedPaths(ProjectDocumentSchema.safeParse(withGcp({ ...gcp, project })))).toEqual([
      ['environments', 'production', 'gcp', 'project'],
    ]);
  },
);

it.each(['Tokyo', 'asia-northeast', 'europe-west123', ''])(
  'refuses the region %j at environments.production.gcp.region',
  (region) => {
    expect(refusedPaths(ProjectDocumentSchema.safeParse(withGcp({ ...gcp, region })))).toEqual([
      ['environments', 'production', 'gcp', 'region'],
    ]);
  },
);

it('requires the region', () => {
  expect(refusedPaths(ProjectDocumentSchema.safeParse(withGcp({ project: gcp.project })))).toEqual([
    ['environments', 'production', 'gcp', 'region'],
  ]);
});

it('refuses gcp with another target at environments.production.gcp', () => {
  expect(refusedPaths(ProjectDocumentSchema.safeParse(withGcp(gcp, 'single-vm')))).toEqual([
    ['environments', 'production', 'gcp'],
  ]);
});

const image = `ghcr.io/acme/desk@sha256:${'a1'.repeat(32)}`;
const desk = { image, url: 'https://desk.example.com' };
const withApps = (apps: unknown): unknown => ({
  ...minimal,
  environments: {
    ...minimal.environments,
    production: { target: 'single-vm', url: 'https://agents.example.com', apps },
  },
});

it('accepts environments.production.apps with a digest image and an https url', () => {
  const document = withApps({ desk, 'service-desk': desk });
  expect(ProjectDocumentSchema.parse(document)).toEqual(document);
});

it.each([
  'ghcr.io/acme/desk:latest',
  'ghcr.io/acme/desk@sha256:abc',
  `ghcr.io/acme/desk@sha256:${'A1'.repeat(32)}`,
  `ghcr.io/acme/desk@sha256:${'0'.repeat(64)}`,
  `ghcr.io/acme desk@sha256:${'a1'.repeat(32)}`,
])(
  'refuses an app image without a digest at environments.production.apps.<name>.image (%s)',
  (refused) => {
    expect(
      refusedPaths(
        ProjectDocumentSchema.safeParse(withApps({ desk: { ...desk, image: refused } })),
      ),
    ).toEqual([['environments', 'production', 'apps', 'desk', 'image']]);
  },
);

it.each([
  'https://desk.example.com/app',
  'http://desk.example.com',
  'https://desk.example.com/?a=1',
])('refuses an app url with a path (%s)', (url) => {
  expect(
    refusedPaths(ProjectDocumentSchema.safeParse(withApps({ desk: { ...desk, url } }))),
  ).toEqual([['environments', 'production', 'apps', 'desk', 'url']]);
});

it('refuses an unknown key under an app', () => {
  expect(
    refusedPaths(
      ProjectDocumentSchema.safeParse(withApps({ desk: { ...desk, schema: 'app_desk' } })),
    ),
  ).toEqual([['environments', 'production', 'apps', 'desk', 'schema']]);
});

it('refuses an app name that is not a name key, and an own __proto__ key', () => {
  expect(
    refusedPaths(ProjectDocumentSchema.safeParse(withApps({ Desk: desk }))).map((path) =>
      path.slice(0, 4),
    ),
  ).toEqual([['environments', 'production', 'apps', 'Desk']]);
  const prototypeKeyed = JSON.parse(`{"__proto__": ${JSON.stringify(desk)}}`) as unknown;
  expect(refusedPaths(ProjectDocumentSchema.safeParse(withApps(prototypeKeyed)))).toEqual([
    ['environments', 'production', 'apps', '__proto__'],
  ]);
});

it('derives the schema name from the app name', () => {
  expect(appSchemaName('desk')).toBe('app_desk');
  expect(appSchemaName('service-desk')).toBe('app_service_desk');
});
