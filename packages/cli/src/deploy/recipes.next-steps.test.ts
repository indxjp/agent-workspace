import { describe, expect, it } from 'vitest';

import { composeProjectName } from '../render/env.ts';
import { DEPLOY_RECIPES } from './recipes.ts';
import { DESK, FACTS } from './recipes.test-support.ts';

describe('DEPLOY_RECIPES nextSteps, byte for byte what aw deploy printed (#948)', () => {
  it('single-vm', () => {
    expect(DEPLOY_RECIPES['single-vm'].nextSteps(FACTS)).toEqual([
      'next: caddy reverse-proxy --from agents.acme.example --to 127.0.0.1:3000',
      'next: aw login --url https://agents.acme.example',
      `the Owner is admin@localhost.test; the password is BOOTSTRAP_ADMIN_PASSWORD in ${FACTS.envFile}`,
    ]);
  });

  it('single-vm adds, per app in name order, its Caddy site, its .env lines and its connector (#1512)', () => {
    const steps = DEPLOY_RECIPES['single-vm'].nextSteps({
      ...FACTS,
      apps: { ...DESK, crm: { ...DESK.desk, url: 'https://crm.acme.example' } },
    });

    expect(steps.slice(3)).toEqual([
      'next: caddy reverse-proxy --from crm.acme.example --to 127.0.0.1:3100',
      `next: set AW_APP_CRM_API_KEY (an Admin API key), AW_APP_CRM_WORKSPACE_ID and, after registering the connector, AW_APP_CRM_CONNECTOR_ID in ${FACTS.envFile}, then aw deploy production --yes`,
      "next: store AW_APP_CRM_IDENTITY_SECRET's value as the workspace secret APP_CRM_IDENTITY (aw secrets create --name APP_CRM_IDENTITY --value-stdin), then register connector crm → https://crm.acme.example/api/mcp with identity: { secret: APP_CRM_IDENTITY } (aw connectors create --file …; docs/40-operate/deploy/single-vm.md#apps)",
      'next: caddy reverse-proxy --from desk.acme.example --to 127.0.0.1:3101',
      `next: set AW_APP_DESK_API_KEY (an Admin API key), AW_APP_DESK_WORKSPACE_ID and, after registering the connector, AW_APP_DESK_CONNECTOR_ID in ${FACTS.envFile}, then aw deploy production --yes`,
      "next: store AW_APP_DESK_IDENTITY_SECRET's value as the workspace secret APP_DESK_IDENTITY (aw secrets create --name APP_DESK_IDENTITY --value-stdin), then register connector desk → https://desk.acme.example/api/mcp with identity: { secret: APP_DESK_IDENTITY } (aw connectors create --file …; docs/40-operate/deploy/single-vm.md#apps)",
    ]);
  });

  it('kubernetes names the Secrets and the ingress, and no caddy, terraform or overlay', () => {
    const overlay = '/state/deploy/helm/values.yaml';
    const steps = DEPLOY_RECIPES.kubernetes.nextSteps({ ...FACTS, envFile: overlay });

    expect(steps).toEqual([
      'the chart reads three Secrets you create in the agent-workspace namespace: agent-workspace-database, agent-workspace-object-store, agent-workspace-secrets',
      'next: point agents.acme.example at the ingress controller: kubectl -n agent-workspace get ingress',
      'next: aw login --url https://agents.acme.example',
      'the Owner and password are BOOTSTRAP_ADMIN and BOOTSTRAP_ADMIN_PASSWORD in agent-workspace-secrets',
    ]);
    const text = steps.join('\n');
    expect(text).not.toContain('caddy');
    expect(text).not.toContain('terraform');
    expect(text).not.toContain(overlay);
  });

  it('vercel without a frontend', () => {
    expect(DEPLOY_RECIPES.vercel.nextSteps(FACTS)).toEqual([
      'next: attach agents.acme.example to the control-plane Vercel project (Settings, Domains) if it is not a *.vercel.app address',
      'next: aw login --url https://agents.acme.example',
      `the Owner is admin@localhost.test; the password is BOOTSTRAP_ADMIN_PASSWORD in ${FACTS.envFile}`,
    ]);
  });

  it('vercel with a frontend names the allowed origin after the slugged project name (#830)', () => {
    const [first, ...rest] = DEPLOY_RECIPES.vercel.nextSteps({ ...FACTS, frontend: true });

    expect(first).toBe(
      'next: aw push and aw promote the agent; unless deploy said otherwise above, the control plane allows https://acme-ai-web.vercel.app; list a custom domain in allowedOrigins of the surface web/ calls',
    );
    expect(rest).toEqual(DEPLOY_RECIPES.vercel.nextSteps(FACTS));

    const [slugged] = DEPLOY_RECIPES.vercel.nextSteps({
      ...FACTS,
      projectName: 'agent-workspace',
      frontend: true,
    });
    expect(slugged).toContain(
      `the control plane allows https://${composeProjectName('agent-workspace')}-web.vercel.app;`,
    );
    expect(slugged).not.toContain('https://agent-workspace-web.vercel.app');
  });
});
