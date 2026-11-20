import {
  type ProductionEnvironment,
  type ProjectDocument,
} from '@indx-workspace/contracts/project-file';

import { createRedactor } from './redact.ts';

export const FACTS = {
  projectName: 'acme-ai',
  url: 'https://agents.acme.example',
  adminEmail: 'admin@localhost.test',
  envFile: '/home/owner/.config/agent-workspace/deployments/acme-ai/production/.env',
  moduleDirectory: null,
  managedStack: false,
  webUrl: null,
  oidcIssuer: null,
  domain: null,
  loadBalancerIp: null,
  frontend: false,
  apps: {},
} as const;

/** The redactor `aw deploy` prints through, over an `.env` holding the generated Owner password. */
export function redactor(): (text: string) => string {
  return createRedactor({ BOOTSTRAP_ADMIN_PASSWORD: 'generated-password-0123456789' });
}

/** Only `name` and `environments.production.apps` are read by the recipes' project checks. */
export function projectNamed(length: number): ProjectDocument {
  return { name: 'a'.repeat(length), environments: {} } as ProjectDocument;
}

export function projectWithApps(apps: ProductionEnvironment['apps']): ProjectDocument {
  return {
    name: 'acme-ai',
    environments: { production: { target: 'single-vm', url: FACTS.url, apps } },
  } as unknown as ProjectDocument;
}

export const DESK = {
  desk: { image: `ghcr.io/acme/desk@sha256:${'a1'.repeat(32)}`, url: 'https://desk.acme.example' },
};

/** What `run` throws, or `undefined` when it does not throw. */
export function refusalOf(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
