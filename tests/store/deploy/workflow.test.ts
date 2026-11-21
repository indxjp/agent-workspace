/** The store deploy workflow stays inert until configured, keeps the Anthropic key out of reach, and is no CI need. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const text = readFileSync(root('.github/workflows/store-deploy.yml'), 'utf8');
const code = text
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');
const steps = code.split(/^ {6}- /mu).slice(1);
const stepWith = (needle: string): string => steps.find((step) => step.includes(needle)) ?? '';

describe('store-deploy.yml', () => {
  it('starts on a push to main and on a store-v tag, and nothing else', () => {
    const on = /^on:\n((?: {2}.*\n|\n)+)/mu.exec(code)?.[1] ?? '';
    expect([...on.matchAll(/^ {2}([a-z_]+):/gmu)].map((match) => match[1])).toEqual(['push']);
    expect(on).toContain('branches: [main]');
    expect(on).toContain("tags: ['store-v*']");
  });

  it('is skipped unless the repository variable of the ref is set, and only in the organisation', () => {
    const guard = /^ {4}if: (.*)$/mu.exec(code)?.[1] ?? '';
    expect(guard).toMatch(/^github\.repository_owner == 'INDXDev' && \(/u);
    expect(guard).toContain(
      "github.ref == 'refs/heads/main' && vars.STORE_STAGING_GCP_PROJECT != ''",
    );
    expect(guard).toContain(
      "startsWith(github.ref, 'refs/tags/store-v') && vars.STORE_PRODUCTION_GCP_PROJECT != ''",
    );
  });

  it('runs production through its protected environment and staging through its own', () => {
    expect(code).toContain(
      "environment: ${{ startsWith(github.ref, 'refs/tags/store-v') && 'store-production' || 'store-staging' }}",
    );
    expect(code).toMatch(
      /group: store-deploy-\$\{\{ startsWith\(github\.ref, 'refs\/tags\/store-v'\) && 'production' \|\| 'staging' \}\}/u,
    );
    expect(code).toMatch(/cancel-in-progress: false/u);
  });

  it('authenticates with workload identity federation and holds no key', () => {
    expect(code).toMatch(/permissions:\n {2}contents: read\n {2}id-token: write/u);
    expect(code).toContain(
      'workload_identity_provider: ${{ secrets.STORE_GCP_WORKLOAD_IDENTITY_PROVIDER }}',
    );
    expect(code).not.toMatch(/credentials_json|GOOGLE_APPLICATION_CREDENTIALS|_KEY\b/u);
    const secrets = [...code.matchAll(/\$\{\{ secrets\.([A-Z_]+) \}\}/gu)].map((match) => match[1]);
    expect(secrets.sort()).toEqual([
      'STORE_GCP_DEPLOY_SERVICE_ACCOUNT',
      'STORE_GCP_WORKLOAD_IDENTITY_PROVIDER',
    ]);
  });

  it('refuses a production tag that is not on main', () => {
    const step = stepWith('name: Refuse a production tag');
    expect(step).toContain("if: startsWith(github.ref, 'refs/tags/store-v')");
    expect(step).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
  });

  it('reads only metadata of the Anthropic key secret and never its value', () => {
    const accesses = [...code.matchAll(/gcloud secrets versions access[^\n]*/gu)].map((m) => m[0]);
    expect(accesses).toHaveLength(4);
    expect(accesses.filter((access) => access.includes('store-demo-operator-token'))).toHaveLength(
      3,
    );
    expect(accesses.filter((access) => access.includes('store-oidc-client-secret'))).toHaveLength(
      1,
    );
    expect(code).not.toMatch(/versions access[^\n]*store-anthropic-api-key/u);
    const check = stepWith('has an enabled version');
    expect(check).toContain('store-anthropic-api-key store-demo-operator-token');
    expect(check).toContain('gcloud secrets versions list');
    expect(check).toContain("--filter='state:enabled'");
  });

  it('passes the apps workspace id and each app key secret id from the environment variables, never a secret', () => {
    const jobEnv = /^ {4}env:\n((?: {6}.*\n)+)/mu.exec(code)?.[1] ?? '';
    const names = [
      'STORE_APPS_WORKSPACE_ID',
      ...['STORE', 'CRM', 'SERVICE_DESK', 'WIKI', 'TEAM_CHAT'].map(
        (app) => `STORE_API_KEY_SECRET_${app}`,
      ),
    ];
    for (const name of names) expect(jobEnv).toContain(`${name}: \${{ vars.${name} }}`);
  });

  it('passes the sign-in issuer and client ids from the environment variables, never a secret', () => {
    const jobEnv = /^ {4}env:\n((?: {6}.*\n)+)/mu.exec(code)?.[1] ?? '';
    const names = [
      'STORE_OIDC_ISSUER',
      'STORE_OIDC_CLIENT_ID',
      ...['STORE', 'CRM', 'SERVICE_DESK', 'WIKI', 'TEAM_CHAT'].flatMap((app) => [
        `STORE_APP_OIDC_CLIENT_ID_${app}`,
        `STORE_APP_CLIENT_ID_${app}`,
      ]),
    ];
    for (const name of names) expect(jobEnv).toContain(`${name}: \${{ vars.${name} }}`);
  });

  it('reads the platform sign-in client secret only into the deploy step, masked, and only with an issuer', () => {
    const jobEnv = /^ {4}env:\n((?: {6}.*\n)+)/mu.exec(code)?.[1] ?? '';
    expect(jobEnv).not.toContain('AW_OIDC_CLIENT_SECRET');
    const users = steps.filter((step) => step.includes('store-oidc-client-secret'));
    expect(users.map((step) => /name: (.*)/u.exec(step)?.[1])).toEqual(['Deploy']);
    const deploy = users[0] ?? '';
    expect(deploy).toContain('if [ -n "${STORE_OIDC_ISSUER:-}" ]; then');
    expect(deploy).toContain('echo "::add-mask::$AW_OIDC_CLIENT_SECRET"');
    expect(deploy.indexOf('add-mask')).toBeLessThan(deploy.indexOf('aw deploy production --yes'));
  });

  it('hands the operator token only to the steps that call the platform, masked, never to a job env', () => {
    const jobEnv = /^ {4}env:\n((?: {6}.*\n)+)/mu.exec(code)?.[1] ?? '';
    expect(jobEnv).not.toContain('STORE_OPERATOR_TOKEN');
    const users = steps.filter((step) => step.includes('STORE_OPERATOR_TOKEN'));
    expect(users.map((step) => /name: (.*)/u.exec(step)?.[1])).toEqual([
      'Check the platform reaches the Anthropic API with the key',
      'Seed the demo templates',
      'Refresh the staging verification workspace',
    ]);
    for (const step of users) expect(step).toContain('echo "::add-mask::$token"');
    expect(stepWith('tests/store/deploy/readiness.ts')).toContain(
      'node tests/store/deploy/readiness.ts',
    );
    expect(stepWith('tests/store/seed/run.ts')).toContain('node tests/store/seed/run.ts');
  });

  it('deploys the rendered project with aw before it checks and seeds', () => {
    const order = [
      'render.ts',
      'aw deploy production --yes',
      'versions list',
      'readiness.ts',
      'seed/run.ts',
    ];
    const at = order.map((needle) => code.indexOf(needle));
    expect(at).not.toContain(-1);
    // The secret check runs first, so a missing secret fails before any image is built or deployed.
    expect(code.indexOf('versions list')).toBeLessThan(code.indexOf('docker buildx build'));
    expect(at[0]).toBeLessThan(at[1] ?? 0);
    expect(at[1]).toBeLessThan(at[3] ?? 0);
    expect(at[3]).toBeLessThan(at[4] ?? 0);
  });

  it('seeds every entry with a source in staging and the live entries in production', () => {
    const seed = stepWith('name: Seed the demo templates');
    expect(seed).toContain(
      "          STORE_SEED_ENVIRONMENT: ${{ startsWith(github.ref, 'refs/tags/store-v') && 'production' || 'staging' }}\n",
    );
  });

  it('refreshes the staging verification workspace after seeding, and skips with a notice without its id', () => {
    const refresh = stepWith('name: Refresh the staging verification workspace');
    expect(refresh).toContain("if: github.ref == 'refs/heads/main'");
    // The id is a repository variable, read into this step only; it is no secret and never a job env.
    expect(refresh).toContain(
      '          STORE_VERIFICATION_WORKSPACE_ID: ${{ vars.STORE_STAGING_VERIFICATION_WORKSPACE_ID }}\n',
    );
    const jobEnv = /^ {4}env:\n((?: {6}.*\n)+)/mu.exec(code)?.[1] ?? '';
    expect(jobEnv).not.toContain('VERIFICATION_WORKSPACE');
    // Unset: a notice and a clean exit before the token is read, so the deploy does not fail.
    const skip = refresh.indexOf('if [ -z "${STORE_VERIFICATION_WORKSPACE_ID:-}" ]; then');
    expect(skip).toBeGreaterThan(-1);
    expect(refresh.slice(skip)).toMatch(/^[^\n]*\n {12}echo "::notice::[^\n]*"\n {12}exit 0\n/u);
    expect(skip).toBeLessThan(refresh.indexOf('gcloud secrets versions access'));
    expect(refresh).toContain(
      'STORE_OPERATOR_TOKEN="$token" node tests/store/seed/verification.ts',
    );
    // It runs after the seed, the last step, so R1 finds what this deploy seeded.
    expect(code.indexOf('seed/run.ts')).toBeLessThan(code.indexOf('seed/verification.ts'));
    expect(steps.at(-1)).toBe(refresh);
  });

  it('builds every package the app images pack before it builds an app image', () => {
    const build = stepWith('run-many -t build');
    for (const name of [
      'contracts',
      'platforms',
      'sdk',
      'react',
      'app',
      'aw',
      'cli',
      'embedded',
      'create',
    ]) {
      expect(build).toMatch(new RegExp(`@indx-workspace/${name}[, ]`, 'u'));
    }
    expect(code.indexOf('run-many -t build')).toBeGreaterThan(-1);
    expect(code.indexOf('run-many -t build')).toBeLessThan(code.indexOf('app-image.mjs'));
  });

  it('is no ci-success need and is listed as an internal-only workflow', () => {
    const ci = readFileSync(root('.github/workflows/ci.yml'), 'utf8');
    expect(ci).not.toContain('store-deploy');
    const rules = readFileSync(root('scripts/check-workflows/workflow-rules.mjs'), 'utf8');
    expect(rules).toContain('store-deploy.yml');
  });
});
