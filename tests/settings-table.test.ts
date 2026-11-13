/**
 * `docs/operations/settings.md` is generated from the settings modules' catalogues (refactoring
 * part 03, step 7), and this is the gate that says so: the committed table must match what the
 * catalogues render, and each catalogue must list exactly the variables its parser reads. A new
 * variable read without a row, or a row left behind after its read is removed, fails here, and so
 * does a changed default that the table does not show.
 *
 * `node tests/settings-table/run.mjs` writes the table (wired into `pnpm docs:generate`); with
 * `--check` it runs this comparison (wired into `pnpm docs:check`).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { AUTH_SETTINGS, authSettingsFromEnvironment } from '../apps/web/server/auth-settings.js';
import {
  readWebSettings,
  WEB_SETTINGS,
  type SettingDescription,
  type SettingsEnvironment,
} from '../apps/web/server/settings.js';
import { EGRESS_PROXY_SETTINGS, loadProxyConfig } from '@agent-workspace/egress-proxy';

import {
  checkGoogleSecretVersion,
  configuredMasterKeyBackend,
  CORE_SETTINGS,
  DATABASE_TOOL_SETTINGS,
  loadMasterKey,
  readAwsKmsMasterKeyConfig,
  readAzureKeyVaultMasterKeyConfig,
  readGoogleSecretManagerSecretVersion,
  readTracingSettings,
} from '@agent-workspace/core/settings';
import {
  readDatabaseConfig,
  readSeedOptions,
  resolveMigrationsDir,
} from '@agent-workspace/core/db/unscoped';
import { GATEWAY_SETTINGS, readGatewayServerSettings } from '@agent-workspace/gateway/settings';
import {
  readRunnerManagerSettings,
  RUNNER_MANAGER_SETTINGS,
} from '../apps/runner/src/manager-settings.js';

const OUTPUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../docs/operations/settings.md',
);

const keyDirectory = mkdtempSync(path.join(tmpdir(), 'settings-table-'));
const keyFile = path.join(keyDirectory, 'egress.key');
writeFileSync(keyFile, 'k'.repeat(40));
afterAll(() => {
  rmSync(keyDirectory, { recursive: true, force: true });
});

const RUNNER_IMAGES = {
  AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'agent:1',
  RUNNER_MANAGER_TOKEN: 't'.repeat(32),
};

interface SettingsModule {
  readonly process: string;
  readonly module: string;
  readonly settings: readonly SettingDescription[];
  /** Calls the module's parser; a refusal is fine, only the reads count. */
  readonly parse: (env: SettingsEnvironment) => unknown;
  /** Environments that between them take every branch that reads a variable. */
  readonly environments: readonly SettingsEnvironment[];
}

/**
 * The shared settings are parsed where they are used, so the table runs those same parsers, each on
 * its own so that a refusal in one does not hide the reads of the next. The master key goes through
 * the readers `createMasterKeyProvider`'s providers call, which load no cloud SDK.
 */
function readCoreSettings(env: SettingsEnvironment): void {
  const attempt = (read: () => unknown): void => {
    try {
      read();
    } catch {
      // A refusal is fine here; only the reads count.
    }
  };
  attempt(() => readDatabaseConfig(env));
  attempt(() => readTracingSettings(env));
  attempt(() => {
    switch (configuredMasterKeyBackend(env)) {
      case 'local-key':
        loadMasterKey(env);
        return;
      case 'kms':
        readAwsKmsMasterKeyConfig(env);
        return;
      case 'secret-manager':
        checkGoogleSecretVersion(readGoogleSecretManagerSecretVersion(env));
        return;
      case 'key-vault':
        readAzureKeyVaultMasterKeyConfig(env);
        return;
    }
  });
}

const MODULES: readonly SettingsModule[] = [
  {
    process: 'web',
    module: 'apps/web/server/settings.ts',
    settings: WEB_SETTINGS,
    parse: readWebSettings,
    environments: [{}, { AW_TRUSTED_PROXY_HOPS: '1', AW_CONTAINER_IDLE_STOP_SECONDS: '900' }],
  },
  {
    process: 'web',
    module: 'apps/web/server/auth-settings.ts',
    settings: AUTH_SETTINGS,
    parse: authSettingsFromEnvironment,
    environments: [
      {},
      {
        SESSION_SECRET: 's'.repeat(40),
        BOOTSTRAP_ADMIN: 'owner@example.com',
        BOOTSTRAP_ADMIN_PASSWORD: 'p'.repeat(16),
        OIDC_ISSUER_URL: 'http://127.0.0.1:9000',
        OIDC_CLIENT_ID: 'client',
        OIDC_CLIENT_SECRET: 'secret',
        OIDC_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/callback',
        AW_DEPLOYMENT_POSTURE: 'local',
        HOST: '127.0.0.1',
      },
      // With no posture named, `NODE_ENV` decides it.
      {
        OIDC_ISSUER_URL: 'http://127.0.0.1:9000',
        OIDC_CLIENT_ID: 'c',
        OIDC_CLIENT_SECRET: 's',
        OIDC_REDIRECT_URI: 'http://127.0.0.1:3000/cb',
      },
    ],
  },
  {
    process: 'shared',
    module: 'packages/core/src/settings.ts',
    settings: CORE_SETTINGS,
    parse: readCoreSettings,
    // One environment per master-key provider; the first also reaches the pool size and the service name.
    environments: [
      {
        DATABASE_URL: 'postgres://aw:aw@127.0.0.1:5432/aw',
        DATABASE_POOL_MAX: '10',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        OTEL_SERVICE_NAME: 'aw',
      },
      { MASTER_KEY_PROVIDER: 'kms', AWS_KMS_KEY_ID: 'key', AWS_KMS_ENCRYPTED_MASTER_KEY: 'AAAA' },
      {
        MASTER_KEY_PROVIDER: 'secret-manager',
        GCP_MASTER_KEY_SECRET: 'projects/p/secrets/s/versions/1',
      },
      {
        MASTER_KEY_PROVIDER: 'key-vault',
        AZURE_KEY_VAULT_URL: 'https://vault.example.net',
        AZURE_MASTER_KEY_SECRET_NAME: 'master-key',
      },
    ],
  },
  {
    process: 'db:migrate, db:seed',
    module: 'packages/core/src/settings.ts',
    settings: DATABASE_TOOL_SETTINGS,
    // The two process entries' own readers; their database settings are the shared rows above.
    parse: (env) => {
      resolveMigrationsDir(env);
      return readSeedOptions(env);
    },
    environments: [
      { MIGRATIONS_DIR: '/migrations', BOOTSTRAP_ADMIN: 'owner@example.com' },
      {
        BOOTSTRAP_ADMIN: 'owner@example.com',
        BOOTSTRAP_ADMIN_NAME: 'Owner',
        WORKSPACE_SLUG: 'team',
        WORKSPACE_NAME: 'Team',
      },
    ],
  },
  {
    process: 'model gateway',
    module: 'packages/gateway/src/settings.ts',
    settings: GATEWAY_SETTINGS,
    parse: readGatewayServerSettings,
    environments: [
      {},
      // The posture is read only for scripted models; under `production` its check reads the issuer.
      { AW_SCRIPTED_MODELS_DIR: '/scripts', NODE_ENV: 'production' },
    ],
  },
  {
    process: 'runner manager',
    module: 'apps/runner/src/manager-settings.ts',
    settings: RUNNER_MANAGER_SETTINGS,
    parse: readRunnerManagerSettings,
    // One environment per driver, each valid so the parse reaches every read on its path.
    environments: [
      { ...RUNNER_IMAGES, AGENT_WORKSPACE_TOOL_HOST_IMAGE: 'tool-host:1' },
      {
        ...RUNNER_IMAGES,
        RUNTIME_DRIVER: 'cloud-run-service',
        RUNTIME_NETWORK: 'net',
        RUNTIME_SUBNETWORK: 'subnet',
        GCP_PROJECT: 'project',
        GCP_REGION: 'asia-northeast1',
        RUNTIME_SERVICE_ACCOUNT: 'runtime@project.iam.gserviceaccount.com',
        AGENT_WORKSPACE_TOOL_HOST_IMAGE: 'tool-host:1',
      },
      {
        RUNTIME_DRIVER: 'aca-sessions',
        RUNNER_MANAGER_TOKEN: 't'.repeat(32),
        ACA_SESSION_POOL_ENDPOINT: 'https://pool.example.net',
      },
      {
        ...RUNNER_IMAGES,
        RUNTIME_DRIVER: 'cloudflare-sandbox',
        CLOUDFLARE_SANDBOX_BRIDGE_URL: 'https://bridge.example.com',
      },
      {
        RUNTIME_DRIVER: 'external',
        EXTERNAL_PROVIDER: 'e2b',
        GATEWAY_PUBLIC_URL: 'https://gateway.example.com',
        AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'agent:build',
        AGENT_WORKSPACE_TOOL_HOST_IMAGE: 'tool-host:build',
        RUNNER_MANAGER_STATELESS: 'true',
        RUNNER_MANAGER_TOKEN: 't'.repeat(32),
      },
      {
        ...RUNNER_IMAGES,
        RUNTIME_DRIVER: 'vercel-sandbox',
        VERCEL_TEAM_ID: 'team',
        VERCEL_PROJECT_ID: 'project',
        GATEWAY_PUBLIC_URL: 'https://gateway.example.com',
      },
      {
        ...RUNNER_IMAGES,
        RUNTIME_DRIVER: 'kubernetes',
        RUNTIME_KUBERNETES_NAMESPACE: 'aw',
        RUNTIME_GATEWAY_SERVICE: 'gateway',
        KUBERNETES_SERVICE_HOST: '10.0.0.1',
      },
    ],
  },
  {
    process: 'egress proxy',
    module: 'packages/egress-proxy/src/config.ts',
    settings: EGRESS_PROXY_SETTINGS,
    parse: loadProxyConfig,
    environments: [
      {
        EGRESS_SESSION_ID: 'session',
        EGRESS_ALLOWLIST: 'example.com',
        EGRESS_ALLOWED_PORTS: '443',
      },
      { EGRESS_MODE: 'shared', EGRESS_CREDENTIAL_KEY_FILE: keyFile },
    ],
  },
];

/** The variable names `parse` reads from each environment. */
function readsOf(
  parse: (env: SettingsEnvironment) => unknown,
  environments: readonly SettingsEnvironment[],
): string[] {
  const read = new Set<string>();
  for (const environment of environments) {
    const recording = new Proxy(environment, {
      get(target, key, receiver) {
        if (typeof key === 'string') read.add(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
      has(target, key) {
        if (typeof key === 'string') read.add(key);
        return Reflect.has(target, key);
      },
      ownKeys() {
        throw new Error(
          'a settings parser must name each variable it reads, not list the environment',
        );
      },
    });
    try {
      parse(recording);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('a settings parser must')) throw error;
    }
  }
  return [...read].sort();
}

const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

function renderSettingsTable(modules: readonly SettingsModule[]): string {
  const rows = modules.flatMap((entry) =>
    entry.settings.map(
      (setting) =>
        `| ${cell(entry.process)} | \`${setting.name}\` | ${cell(setting.default)} | ${cell(setting.meaning)} | \`${entry.module}\` |`,
    ),
  );
  return [
    '# Settings',
    '',
    '<!-- Generated by `node tests/settings-table/run.mjs` from the settings modules. Do not edit by hand. -->',
    '',
    'The environment variables each process parses once at start-up, from the catalogue its settings',
    'module keeps beside its parser, so a default is written in one place. Where a refused value',
    'stops start-up, its meaning says so; the others leave their feature off, and the server log names',
    'the variable. `.env.example` holds only deployment values',
    '([ADR W1-INF-01](../adr/W1-INF-01-env-example-is-six-values.md)).',
    '',
    'Covered: web, the model gateway, the runner manager and the egress proxy, the database,',
    'master key and tracing settings they share (`packages/core`), and the `db:migrate` and `db:seed`',
    'process entries. Most master key and runner manager',
    'settings apply to one `MASTER_KEY_PROVIDER` or `RUNTIME_DRIVER`, named first in the meaning.',
    '',
    '| Process | Variable | When unset | Meaning | Read by |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

describe('the db:seed defaults the table states', () => {
  it('match what readSeedOptions resolves', () => {
    const options = readSeedOptions({ BOOTSTRAP_ADMIN: 'Owner.Name@Example.com' });
    const row = (name: string): string =>
      DATABASE_TOOL_SETTINGS.find((setting) => setting.name === name)?.default ?? '';
    expect(row('WORKSPACE_SLUG')).toBe(`\`${options.workspaceSlug}\``);
    expect(row('WORKSPACE_NAME')).toBe(`\`${options.workspaceName}\``);
    expect(options.adminName).toBe('owner.name');
  });
});

describe('docs/operations/settings.md', () => {
  it('matches what the settings modules declare', () => {
    const rendered = renderSettingsTable(MODULES);
    if (process.env['SETTINGS_TABLE_WRITE'] === '1') {
      writeFileSync(OUTPUT, rendered);
      return;
    }
    expect(readFileSync(OUTPUT, 'utf8'), 'run `node tests/settings-table/run.mjs`').toBe(rendered);
  });

  for (const entry of MODULES) {
    it(`${entry.module} lists exactly the variables its parser reads`, () => {
      const listed = entry.settings.map((setting) => setting.name).sort();
      expect(listed.length).toBeGreaterThan(0);
      expect(new Set(listed).size, 'a variable is listed twice').toBe(listed.length);
      expect(readsOf(entry.parse, entry.environments)).toEqual(listed);
    });

    it(`${entry.module} gives every variable a default and a meaning`, () => {
      for (const setting of entry.settings) {
        expect(setting.name, setting.name).toMatch(/^[A-Z][A-Z0-9_]*$/u);
        expect(setting.default.trim(), setting.name).not.toBe('');
        expect(setting.meaning.trim(), setting.name).not.toBe('');
      }
    });
  }
});
