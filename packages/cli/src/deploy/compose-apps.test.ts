import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  APP_PORT_BASE,
  appEnvName,
  appRoleSql,
  composeApps,
  renderComposeApps,
  renderEmptyComposeApps,
} from './compose-apps.ts';

const PLATFORM_URL = 'https://agents.acme.example';

// Listed out of order: the overlay sorts by name.
const APPS = {
  'service-desk': {
    image: `ghcr.io/acme/service-desk@sha256:${'b2'.repeat(32)}`,
    url: 'https://desk.acme.example',
  },
  crm: { image: `ghcr.io/acme/crm@sha256:${'a1'.repeat(32)}`, url: 'https://crm.acme.example' },
} as const;

async function golden(): Promise<string> {
  return readFile(new URL('./fixtures/compose-apps.yaml', import.meta.url), 'utf8');
}

describe('renderComposeApps (#1512)', () => {
  it('renders two apps exactly as the golden overlay', async () => {
    expect(renderComposeApps(APPS, PLATFORM_URL)).toBe(await golden());
  });

  it('publishes app i, in name order, on 127.0.0.1:<3100 + i>', () => {
    expect(composeApps(APPS).map(({ name, port }) => [name, port])).toEqual([
      ['crm', APP_PORT_BASE],
      ['service-desk', APP_PORT_BASE + 1],
    ]);
    const overlay = parse(renderComposeApps(APPS, PLATFORM_URL)) as {
      services: Record<string, { ports?: string[] }>;
    };
    expect(overlay.services['app-crm']?.ports).toEqual(['127.0.0.1:3100:3000']);
    expect(overlay.services['app-service-desk']?.ports).toEqual(['127.0.0.1:3101:3000']);
  });

  it('renders no secret value: every credential is a ${…} reference to a .env line', () => {
    const overlay = renderComposeApps(APPS, PLATFORM_URL);
    expect(overlay).not.toMatch(/AW_APP_[A-Z_]+_(?:DB_PASSWORD|IDENTITY_SECRET)=/u);
    const services = (parse(overlay) as { services: Record<string, unknown> }).services;
    const app = services['app-service-desk'] as { environment: Record<string, string> };
    expect(app.environment['DATABASE_URL']).toBe(
      'postgres://app_service_desk:${AW_APP_SERVICE_DESK_DB_PASSWORD:?run aw deploy production to generate AW_APP_SERVICE_DESK_DB_PASSWORD for service-desk}@postgres:5432/${POSTGRES_DB:?set POSTGRES_DB in .env}',
    );
    expect(app.environment['AW_APP_IDENTITY_SECRET']).toMatch(
      /^\$\{AW_APP_SERVICE_DESK_IDENTITY_SECRET:\?/u,
    );
  });

  it("never hands an app the platform's DATABASE_URL", () => {
    expect(renderComposeApps(APPS, PLATFORM_URL)).not.toContain('${DATABASE_URL');
  });

  it('writes the role script with $$$$ for Compose and the password only as :APP_PASSWORD', () => {
    const overlay = parse(renderComposeApps(APPS, PLATFORM_URL)) as {
      services: Record<string, { environment: Record<string, string>; command: string[] }>;
    };
    const role = overlay.services['app-crm-role'];
    expect(role?.environment['APP_SQL']).toContain('DO $$$$\n');
    expect(role?.environment['APP_SQL']).toContain("PASSWORD :'APP_PASSWORD';");
    expect(role?.environment['APP_SQL']).toContain(
      'CREATE SCHEMA IF NOT EXISTS app_crm AUTHORIZATION app_crm;',
    );
    expect(role?.command.at(-1)).toContain('-v APP_PASSWORD="$$APP_PASSWORD"');
  });

  it('builds the same role script with single dollars where psql reads it as it stands', () => {
    const sql = appRoleSql('app_x', '$$');
    expect(sql).toContain('DO $$\n');
    expect(sql).toContain('\n$$;\n');
    expect(sql).not.toContain('$$$$');
    expect(sql).toContain("PASSWORD :'APP_PASSWORD';");
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS app_x AUTHORIZATION app_x;');
    // The Compose overlay is the same text with the delimiter doubled for Compose's interpolation.
    expect(appRoleSql('app_x', '$$$$')).toBe(sql.replaceAll('$$', () => '$$$$'));
  });

  it('names the .env infix in upper snake case', () => {
    expect(appEnvName('service-desk')).toBe('SERVICE_DESK');
  });

  it('renders an overlay with no service when there is no app', () => {
    expect(renderComposeApps({}, PLATFORM_URL)).toBe(renderEmptyComposeApps());
    expect(parse(renderEmptyComposeApps())).toEqual({ services: {} });
  });
});
