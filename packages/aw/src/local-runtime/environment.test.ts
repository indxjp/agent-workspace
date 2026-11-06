import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { withRecommendedAnswers } from '@indx-workspace/contracts/setup';
import { parseProjectFile, renderProjectFiles } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../testing.js';
import {
  localStartMessage,
  oidcConfigurationMode,
  readLocalConsolePassword,
  withDevIssuer,
} from './environment.js';

function projectNaming(driver: string) {
  const [file] = renderProjectFiles(withRecommendedAnswers({}), { name: 'demo' });
  if (file === undefined) throw new Error('renderProjectFiles rendered nothing');
  return parseProjectFile(
    file.contents.replace(
      '    cloud: local\n',
      `    cloud: local\n    runtime:\n      default: ${driver}\n`,
    ),
  );
}

describe('localStartMessage runtime driver', () => {
  it('still starts a project that names sandbox-runtime (#818)', () => {
    const start = localStartMessage(projectNaming('sandbox-runtime'), '/work/demo');
    expect(start.environment.runtimeDriver).toBe('sandbox-runtime');
  });

  it('refuses a driver the local runtime cannot provision', () => {
    expect(() => localStartMessage(projectNaming('kubernetes'), '/work/demo')).toThrow(
      /cannot run the kubernetes driver locally/u,
    );
  });
});

/** The recommended project, with `extra` written as top-level keys before `environments:`. */
function projectWith(extra: string) {
  const [file] = renderProjectFiles(withRecommendedAnswers({}), { name: 'demo' });
  if (file === undefined) throw new Error('renderProjectFiles rendered nothing');
  if (!file.contents.includes('\nenvironments:\n')) throw new Error('no environments key');
  return parseProjectFile(file.contents.replace('\nenvironments:\n', `\n${extra}environments:\n`));
}

describe('localStartMessage features (ADR-0160 D5, issue #1495)', () => {
  it('sends no features for a file without them, so the start message is unchanged', () => {
    const start = localStartMessage(projectWith(''), '/work/demo');
    expect(start.environment).toEqual({
      port: 3000,
      bootstrapAdmin: 'admin@localhost.test',
      modelSecrets: ['ANTHROPIC_API_KEY'],
    });
    expect(start.environment).not.toHaveProperty('features');
  });

  it("sends the file's features, in file order", () => {
    const start = localStartMessage(projectWith('features: [files, chat, runs]\n'), '/work/demo');
    expect(start.environment.features).toEqual(['files', 'chat', 'runs']);
  });
});

describe('the development issuer inputs (ADR-0161 amendment DI2, DI5, DI6; issue #2075)', () => {
  it('runs the dev issuer with no OIDC_*, the own IdP with all four, and refuses a partial set', async () => {
    const cwd = await tempDirectory();
    expect(await oidcConfigurationMode({}, cwd)).toBe('dev-issuer');
    expect(await oidcConfigurationMode({ OIDC_ISSUER_URL: '  ' }, cwd)).toBe('dev-issuer');
    const all = {
      OIDC_ISSUER_URL: 'https://idp.example.test',
      OIDC_CLIENT_ID: 'c',
      OIDC_CLIENT_SECRET: 's',
      OIDC_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/callback',
    };
    expect(await oidcConfigurationMode(all, cwd)).toBe('own-idp');
    await writeFile(path.join(cwd, '.env'), 'OIDC_CLIENT_SECRET=from-dotenv\n');
    const refused = oidcConfigurationMode({}, cwd);
    await expect(refused).rejects.toThrow(
      /^oidc_configuration_incomplete: OIDC_CLIENT_SECRET is set but OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_REDIRECT_URI are not/u,
    );
    await expect(oidcConfigurationMode({}, cwd)).rejects.not.toThrow(/from-dotenv/u);
  });

  it('reads the console password from the environment, then .env, then the secrets file', async () => {
    const cwd = await tempDirectory();
    expect(await readLocalConsolePassword({}, cwd)).toBeUndefined();
    await mkdir(path.join(cwd, '.agent-workspace', 'secrets'), { recursive: true });
    await writeFile(
      path.join(cwd, '.agent-workspace', 'secrets', 'local-secrets.json'),
      JSON.stringify({ BOOTSTRAP_ADMIN_PASSWORD: 'from-file' }),
    );
    expect(await readLocalConsolePassword({}, cwd)).toBe('from-file');
    await writeFile(path.join(cwd, '.env'), 'BOOTSTRAP_ADMIN_PASSWORD=from-dotenv\n');
    expect(await readLocalConsolePassword({}, cwd)).toBe('from-dotenv');
    expect(await readLocalConsolePassword({ BOOTSTRAP_ADMIN_PASSWORD: 'from-env' }, cwd)).toBe(
      'from-env',
    );
  });

  it('adds devIssuer with the console client registered on the web port', () => {
    const start = localStartMessage(projectNaming('sandbox-runtime'), '/work/demo');
    const registered: string[] = [];
    const secret = 's'.repeat(43);
    const ownerSubject = `local:${'o'.repeat(43)}`;
    const issuer = {
      url: 'http://127.0.0.1:3200',
      registerClient: (clientId: string, redirectUri: string) => {
        registered.push(`${clientId} ${redirectUri}`);
        return secret;
      },
    };
    const withIssuer = withDevIssuer(start, issuer, ownerSubject);
    expect(registered).toEqual(['aw-local-console http://127.0.0.1:3000/api/auth/callback']);
    expect(withIssuer.environment.devIssuer).toEqual({
      issuer: 'http://127.0.0.1:3200',
      clientId: 'aw-local-console',
      clientSecret: secret,
      redirectUri: 'http://127.0.0.1:3000/api/auth/callback',
      ownerSubject,
    });
  });
});
