import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  CLAUDE_AGENT_SDK_RUNTIME_IMAGE_KEY,
  parseEnvironment,
  type DeploymentImages,
} from '../deployment.js';
import { defaultProfile } from '../profile-defaults.js';
import { DEPLOYMENT_CLOUDS, type DeploymentCloud } from '../profile.js';
import { renderDeployArtefacts, renderDeploymentArtefacts } from './artefacts.js';
import { renderEnv, type EnvSecrets } from './env.js';
import { helmOverlaySkipReason, renderHelmValues } from './helm-values.js';
import { renderTerraformVariables, type TerraformVariableOptions } from './terraform-vars.js';

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const images: DeploymentImages = {
  web: `registry.example/web@${digest('1')}`,
  gateway: `registry.example/gateway@${digest('2')}`,
  runner: `registry.example/runner@${digest('3')}`,
  runtime: `registry.example/runtime@${digest('4')}`,
  postgres: `registry.example/postgres@${digest('5')}`,
  seaweedfs: `registry.example/seaweedfs@${digest('6')}`,
};
const secrets: EnvSecrets = {
  adminPassword: 'admin-password',
  postgresPassword: 'postgres-password',
  objectStoreSecretKey: 'object-store-secret',
  masterEncryptionKey: 'a'.repeat(64),
  gatewayTokenSecret: 'b'.repeat(64),
  runnerManagerToken: 'c'.repeat(64),
  sessionSecret: 'd'.repeat(64),
  cronSecret: 'e'.repeat(64),
};

/** What a cloud deployment pulls: no PostgreSQL and no SeaweedFS, because the cloud supplies both. */
const cloudImages: DeploymentImages = {
  web: images.web,
  gateway: images.gateway,
  runner: images.runner,
  runtime: images.runtime,
};

/** The profile each `--cloud` value generates, with every secret and digest stubbed. */
export function fixtureArtefacts(cloud: DeploymentCloud) {
  return renderDeploymentArtefacts({
    profile: defaultProfile({
      cloud,
      projectName: 'acme-ai',
      ...(cloud === 'local' ? { localObjectStore: 'seaweedfs' as const } : {}),
    }),
    secrets,
    images: cloud === 'local' ? images : cloudImages,
    dockerGroupId: 0,
    projectName: 'acme-ai',
  });
}

/**
 * `deploy/helm/values.yaml` → `deploy-helm-values.yaml`; `.env` → `env`.
 *
 * The leading dot goes because `.gitignore` excludes `.env` and an uncommitted golden pins
 * nothing. The name that leaves has no extension, so `tests/no-sdk-import.test.ts` classifies it
 * by basename — its `INERT_BASENAMES` entry for `env` is the other half of this rule.
 */
export function fixtureName(artefactPath: string): string {
  return artefactPath.replace(/^\./u, '').replaceAll('/', '-');
}

const goldenFor = async (cloud: DeploymentCloud, artefactPath: string) =>
  readFile(new URL(`../fixtures/${cloud}/${fixtureName(artefactPath)}`, import.meta.url), 'utf8');

describe('the artefact set each cloud renders', () => {
  it.each(DEPLOYMENT_CLOUDS)('matches the committed golden for %s', async (cloud) => {
    const artefacts = fixtureArtefacts(cloud);
    expect(artefacts.length).toBeGreaterThan(1);
    for (const { path, contents } of artefacts) {
      expect(contents, `${cloud}/${path}`).toBe(await goldenFor(cloud, path));
    }
  });

  it('renders the profile, the environment, and the targets that cloud has', () => {
    const paths = (cloud: DeploymentCloud) => fixtureArtefacts(cloud).map(({ path }) => path);
    expect(paths('local')).toEqual(['agent-workspace.yaml', '.env', '.gitignore']);
    // No AWS Terraform module exists; an EKS cluster is installed with the chart.
    expect(paths('aws')).toEqual([
      'agent-workspace.yaml',
      '.env',
      '.gitignore',
      'deploy/helm/values.yaml',
    ]);
    expect(paths('gcp')).toEqual([
      'agent-workspace.yaml',
      '.env',
      '.gitignore',
      'deploy/helm/values.yaml',
      'deploy/terraform/gcp-cloudrun.auto.tfvars.json',
    ]);
    // No chart overlay for Azure: the chart has only an S3 bridge, while the generated profile
    // selects the native Blob provider wired by the Container Apps Terraform module.
    expect(paths('azure')).toEqual([
      'agent-workspace.yaml',
      '.env',
      '.gitignore',
      'deploy/terraform/azure-container-apps.auto.tfvars.json',
    ]);
    // Vercel has neither a chart nor a Terraform module: only its project settings.
    expect(paths('vercel')).toEqual([
      'agent-workspace.yaml',
      '.env',
      '.gitignore',
      'deploy/vercel/vercel.json',
      'deploy/vercel/gateway.json',
      'deploy/vercel/manager.json',
      'deploy/vercel/frontend.json',
    ]);
    // Cloudflare likewise: the platform, control plane, gateway and manager Workers, each configuration and module.
    expect(paths('cloudflare')).toEqual([
      'agent-workspace.yaml',
      '.env',
      '.gitignore',
      'deploy/cloudflare/wrangler.jsonc',
      'deploy/cloudflare/retention-worker.mjs',
      'deploy/cloudflare/control-plane.wrangler.jsonc',
      'deploy/cloudflare/control-plane-worker.mjs',
      'deploy/cloudflare/gateway.wrangler.jsonc',
      'deploy/cloudflare/gateway-worker.mjs',
      'deploy/cloudflare/manager.wrangler.jsonc',
      'deploy/cloudflare/manager-worker.mjs',
    ]);
  });

  /**
   * The overlay is gated on the store the chart can serve, not on the cloud. The chart maps only
   * the S3 environment contract, so a native Blob profile must use its Terraform target.
   */
  it('withholds the chart overlay from a cloud profile whose store is not a bucket, and says why', () => {
    const azure = defaultProfile({ cloud: 'azure', projectName: 'acme-ai' });
    expect(azure.storage.objects).toBe('azblob://acme-ai-files');
    expect(renderHelmValues(azure, cloudImages)).toBeNull();
    expect(helmOverlaySkipReason(azure)).toMatch(/serves a remote object bucket only/u);

    // Naming a bucket is what brings it back, so the refusal is about the store and nothing else.
    const withBucket = { ...azure, storage: { ...azure.storage, objects: 's3://acme-ai-files' } };
    expect(helmOverlaySkipReason(withBucket)).toBeNull();
    expect(renderHelmValues(withBucket, cloudImages)?.flavour).toBe('values-aks.yaml');

    // The Compose project is not a withheld overlay: it has no chart flavour at all.
    expect(helmOverlaySkipReason(defaultProfile({ cloud: 'local', projectName: 'a' }))).toBeNull();
  });

  /**
   * Every cloud gets the protection, not only the Compose project: a cloud `.env` carries the
   * same generated administrator password, session, gateway and runner-manager secrets, and the
   * deploy guides tell the operator to keep that directory beside `deploy/` in version control.
   */
  it.each(DEPLOYMENT_CLOUDS)('ignores the secret-bearing .env in the %s project', (cloud) => {
    const ignore = fixtureArtefacts(cloud).find(({ path }) => path === '.gitignore');
    expect(ignore?.contents).toMatch(/^\.env$/mu);
  });

  /**
   * `agent-workspace.yaml`'s own header says no secret belongs in it, and the generator writes
   * that file, so the claim has to hold for its own output. Every value the generator invents is
   * checked, not only the PostgreSQL password that used to be in `storage.relational`.
   */
  it.each(DEPLOYMENT_CLOUDS)('commits no generated secret in the %s profile', async (cloud) => {
    const document = await goldenFor(cloud, 'agent-workspace.yaml');
    for (const [name, value] of Object.entries(secrets)) {
      expect(document, `${cloud}/agent-workspace.yaml leaks ${name}`).not.toContain(value);
    }
    // The object and database access key id is `agent_workspace`; the bucket the profile does
    // name is `agent-workspace`, so the underscore is what separates a credential from a store.
    expect(document).not.toContain('agent_workspace');
    // Nothing carries userinfo, which is the shape the leak took: `scheme://user:password@host`.
    expect(document).not.toMatch(/:\/\/[^\s/]*:[^\s/]*@/u);
  });

  /**
   * `templates/compose.yaml` is copied verbatim and takes every value it needs from the rendered
   * `.env` through `${VAR:?…}`, which is what makes `render/env.ts` the single source for the
   * addresses and credentials the containers actually see. A variable the template demands and
   * the renderer does not supply is a project whose `docker compose up` refuses to start, so the
   * two are held against each other here rather than discovered on an operator's machine.
   */
  it('supplies every variable the Compose template demands from the local .env', async () => {
    const template = await readFile(
      new URL('../../templates/compose.yaml', import.meta.url),
      'utf8',
    );
    const demanded = new Set<string>();
    for (const [, name] of template.matchAll(/\$\{([A-Z0-9_]+):\?/gu)) {
      if (name !== undefined) demanded.add(name);
    }
    expect(demanded.size).toBeGreaterThan(10);
    const rendered = parseEnvironment(await goldenFor('local', '.env'));
    for (const name of demanded) {
      expect(rendered[name], `the local .env does not supply ${name}`).toBeTruthy();
    }
  });

  /**
   * A tmpfs entry carries its options after commas, so a YAML flow sequence
   * (`tmpfs: [/tmp:rw,noexec,…]`) splits it into `/tmp:rw`, `noexec`, `nosuid`… and Docker
   * refuses the container with "invalid mount path: 'nodev'". Only block form keeps each entry
   * whole, so every entry must parse as one absolute path with its full option list.
   */
  it('gives every Compose tmpfs mount as one entry with its full option set', async () => {
    const template = await readFile(
      new URL('../../templates/compose.yaml', import.meta.url),
      'utf8',
    );
    const document: unknown = parseYaml(template, { merge: true });
    const services = (document as { services?: Record<string, { tmpfs?: unknown }> }).services;
    expect(services).toBeTypeOf('object');

    const withTmpfs: string[] = [];
    for (const [name, service] of Object.entries(services ?? {})) {
      if (service.tmpfs === undefined) continue;
      withTmpfs.push(name);
      const entries: unknown[] = Array.isArray(service.tmpfs) ? service.tmpfs : [service.tmpfs];
      for (const entry of entries) {
        expect(entry, `${name} has a non-string tmpfs entry`).toBeTypeOf('string');
        expect(entry, `${name} has a tmpfs entry that is not a mount`).toMatch(/^\/[^:,\s]*:\S+$/u);
        if (typeof entry === 'string' && entry.startsWith('/tmp:')) {
          const options = entry.slice('/tmp:'.length).split(',');
          expect(options, `${name} /tmp options`).toEqual(
            expect.arrayContaining(['rw', 'noexec', 'nosuid', 'nodev']),
          );
          expect(options.some((option) => /^size=\d+m$/u.test(option))).toBe(true);
        }
      }
    }
    expect(withTmpfs).toEqual(expect.arrayContaining(['seaweedfs', 'runner', 'gateway', 'web']));
  });

  describe('the Compose template on a shared Docker host', () => {
    interface ComposeNetwork {
      readonly name?: string;
      readonly internal?: boolean;
      readonly labels?: Record<string, string>;
    }
    interface ComposeService {
      readonly ports?: unknown;
      readonly networks?: readonly string[];
      readonly environment?: Record<string, string>;
    }
    interface ComposeDocument {
      readonly name: string;
      readonly services: Record<string, ComposeService>;
      readonly networks: Record<string, ComposeNetwork | null>;
    }
    const template = async () =>
      readFile(new URL('../../templates/compose.yaml', import.meta.url), 'utf8');
    const document = async () =>
      parseYaml(await template(), { merge: true }) as unknown as ComposeDocument;

    /**
     * Docker publishes no port for a container attached only to internal networks: `docker
     * inspect` shows the binding requested and `NetworkSettings.Ports` null (#377 F1).
     */
    it('gives every service that publishes a port at least one non-internal network', async () => {
      const { services, networks } = await document();
      const published = Object.entries(services).filter(([, service]) => service.ports);
      expect(published.map(([name]) => name)).toEqual(['seaweedfs', 'web']);
      for (const [name, service] of published) {
        const external = (service.networks ?? []).filter(
          (network) => networks[network]?.internal !== true,
        );
        expect(external, `${name} publishes a port on internal networks only`).not.toEqual([]);
      }
    });

    it('keeps every other service on the networks it had, and the control network internal', async () => {
      const { services, networks } = await document();
      expect(networks['control']?.internal).toBe(true);
      expect(networks['runtime-control']?.internal).toBe(true);
      const ingress = Object.entries(services)
        .filter(([, service]) => service.networks?.includes('web-ingress') === true)
        .map(([name]) => name);
      expect(ingress).toEqual(['web']);
      expect(services['web']?.networks).toEqual(['control', 'web-ingress']);
    });

    /** `packages/runtime/src/docker.ts` refuses a runtime network without this label (#377 F2). */
    it('labels the runtime network the way the Docker runtime driver requires, and names it to the runner', async () => {
      const { services, networks } = await document();
      const runtimeControl = networks['runtime-control'];
      expect(runtimeControl?.labels).toEqual({ 'agent-workspace.runtime': 'docker-network' });
      expect(services['runner']?.environment?.['RUNTIME_NETWORK']).toBe(runtimeControl?.name);
      expect(services['runner']?.networks).toContain('runtime-control');
      expect(services['gateway']?.networks).toContain('runtime-control');
    });

    /** #394: sandboxes are labelled with the project, and the session cookie is scoped to it. */
    it('names the Compose project to the runner and scopes the session cookie to it', async () => {
      const { services } = await document();
      const project = '${COMPOSE_PROJECT_NAME:?set COMPOSE_PROJECT_NAME in .env}';
      expect(services['runner']?.environment?.['COMPOSE_PROJECT_NAME']).toBe(project);
      expect(services['web']?.environment?.['AW_INSTANCE_ID']).toBe(project);
    });

    it('passes the pinned Claude runtime image to web, so Test Runtime verifies the image it runs', async () => {
      const web = (await document()).services['web'];
      const pinned = `\${${CLAUDE_AGENT_SDK_RUNTIME_IMAGE_KEY}:?${CLAUDE_AGENT_SDK_RUNTIME_IMAGE_KEY} must be digest pinned}`;
      expect(web?.environment?.['RUNTIME_IMAGE']).toBe(pinned);
      expect(web?.environment?.[CLAUDE_AGENT_SDK_RUNTIME_IMAGE_KEY]).toBe(pinned);
    });

    /**
     * A fixed project or network name lets a second generated project, or the repository's own
     * development stack, adopt this project's containers and remove them as orphans (#377 F4).
     */
    it('names the project and every named network after COMPOSE_PROJECT_NAME, never a fixed name', async () => {
      const text = await template();
      const { name, networks } = await document();
      const project = '${COMPOSE_PROJECT_NAME:?set COMPOSE_PROJECT_NAME in .env}';
      expect(name).toBe(project);
      for (const [key, network] of Object.entries(networks)) {
        if (network?.name === undefined) continue;
        expect(network.name, key).toBe(`${project}-${key}`);
      }
      expect(text).not.toMatch(/^name:\s*agent-workspace\s*$/mu);
      expect(text).not.toMatch(/agent-workspace-(?:runtime-control|provider-egress)/u);
    });
  });

  it('is byte-stable, so a golden only changes when a rendering decision does', () => {
    for (const cloud of DEPLOYMENT_CLOUDS) {
      expect(fixtureArtefacts(cloud)).toEqual(fixtureArtefacts(cloud));
    }
  });
});

describe('the Helm and Terraform renderers as functions of the profile alone', () => {
  it('has no chart flavour for the Compose project and no Terraform module for AWS', () => {
    const local = defaultProfile({ cloud: 'local', projectName: 'a' });
    expect(renderHelmValues(local, images)).toBeNull();
    expect(renderTerraformVariables(local, images)).toBeNull();
    const aws = defaultProfile({ cloud: 'aws', projectName: 'a' });
    expect(renderTerraformVariables(aws, images)).toBeNull();
    expect(renderHelmValues(aws, images)?.flavour).toBe('values-eks.yaml');
  });

  it('carries only the values the chart and the modules cannot default', () => {
    const gcp = defaultProfile({ cloud: 'gcp', projectName: 'acme-ai' });
    // The chart's own values.yaml ships all-zero placeholder digests precisely so that an
    // unconfigured install cannot start; the images are the one thing it cannot default. One per
    // component, and `runnerManager` is the `runner` reference — the runner manager is the root
    // Dockerfile's `runner` target, which is what the release publishes under that name.
    const overlay = renderHelmValues(gcp, images)?.contents;
    expect(overlay).toContain(`  web: ${images.web}`);
    expect(overlay).toContain(`  gateway: ${images.gateway}`);
    expect(overlay).toContain(`  runnerManager: ${images.runner}`);
    // ENG-07 (ADR-0073): `images.runtime` is the chart's `engine → image` map.
    expect(overlay).toContain(`  runtime:\n    claude-agent-sdk: ${images.runtime}`);
    const terraform = renderTerraformVariables(gcp, images);
    expect(terraform?.module).toBe('gcp-cloudrun');
    expect(Object.keys(JSON.parse(terraform?.contents ?? '{}') as object)).toEqual([
      'bootstrap_admin_email',
      'images',
    ]);
  });

  it('renders public_url for every Terraform module, and only when .env carries the origin', async () => {
    const options = { publicUrl: 'https://agents.acme.example' };
    const variables = (cloud: 'gcp' | 'azure', given: TerraformVariableOptions = options) =>
      JSON.parse(
        renderTerraformVariables(defaultProfile({ cloud, projectName: 'acme-ai' }), images, given)
          ?.contents ?? '{}',
      ) as object;

    expect(variables('gcp')).toMatchObject({ public_url: options.publicUrl });
    expect(variables('gcp', {})).not.toHaveProperty('public_url');
    expect(variables('azure')).toMatchObject({ public_url: options.publicUrl });
    expect(variables('azure', {})).not.toHaveProperty('public_url');
    for (const module of ['gcp-cloudrun', 'azure-container-apps']) {
      const declarations = await readFile(
        new URL(`../../../../infra/terraform/${module}/variables.tf`, import.meta.url),
        'utf8',
      );
      expect(declarations, `${module} must declare public_url`).toContain('variable "public_url"');
    }
  });

  it('renders publicUrl in the Helm overlay ahead of images, and only when .env carries the origin', () => {
    const publicUrl = 'https://agents.acme.example:8443';
    for (const cloud of ['gcp', 'aws'] as const) {
      const profile = defaultProfile({ cloud, projectName: 'acme-ai' });
      const without = renderHelmValues(profile, images)?.contents ?? '';
      expect(without).not.toContain('publicUrl');
      expect(renderHelmValues(profile, images, undefined)?.contents).toBe(without);

      const contents = renderHelmValues(profile, images, publicUrl)?.contents ?? '';
      const overlay = parseYaml(contents) as {
        publicUrl: string;
        images: { runtime: Record<string, string> };
      };
      expect(overlay.publicUrl).toBe(publicUrl);
      expect(overlay.images.runtime['claude-agent-sdk']).toBe(images.runtime);
      expect(Object.keys(overlay)).toEqual(['publicUrl', 'images']);
    }
  });

  it('hands the .env origin to both the overlay and the tfvars of one profile', () => {
    const profile = defaultProfile({ cloud: 'gcp', projectName: 'acme-ai' });
    const publicUrl = 'https://agents.acme.example';
    const rendered = renderDeployArtefacts(profile, images, { publicUrl });
    const content = (path: string) => rendered.find((item) => item.path === path)?.contents ?? '';
    expect(content('deploy/helm/values.yaml')).toContain(`publicUrl: ${publicUrl}`);
    expect(content('deploy/terraform/gcp-cloudrun.auto.tfvars.json')).toContain(
      `"public_url": "${publicUrl}"`,
    );
    const unset = JSON.stringify(renderDeployArtefacts(profile, images));
    expect(unset).not.toContain('publicUrl');
    expect(unset).not.toContain('public_url');
  });

  // `infra/tests/contracts.test.mjs` holds the committed goldens against the same modules, but
  // that file runs only in the gcp-small acceptance workflow. This is the copy `pnpm test` runs,
  // and it reads the live renderer rather than a golden, so a renamed module variable fails here
  // the moment the renderer stops agreeing with the module.
  it('renders only variables the target module declares', async () => {
    for (const cloud of ['gcp', 'azure'] as const) {
      const profile = defaultProfile({ cloud, projectName: 'acme-ai' });
      const rendered = renderTerraformVariables(profile, images);
      expect(rendered).not.toBeNull();
      const declarations = await readFile(
        new URL(`../../../../infra/terraform/${rendered?.module}/variables.tf`, import.meta.url),
        'utf8',
      );
      for (const name of Object.keys(JSON.parse(rendered?.contents ?? '{}') as object)) {
        expect(declarations, `${rendered?.module} must declare ${name}`).toContain(
          `variable "${name}"`,
        );
      }
    }
  });

  /**
   * The renderer names the object-store credential `OBJECT_STORAGE_*`, which is the inventory
   * `.env.example` documents, and `apps/web/server/composition/storage.ts` reads the `AWS_*`
   * names. The Compose template translates between the two; on the chart path only the Deployment
   * can, so the two halves are held against each other — a key an operator fills in exactly as the
   * rendered file says, and nothing reading it, is a control plane with no files API.
   *
   * `infra/tests/contracts.test.mjs` holds the same pairing, but that file runs only in the
   * `gcp-small` acceptance workflow. This is the copy `pnpm test` runs, and it reads the rendered
   * key set from the live renderer rather than from a golden.
   */
  it('has the chart map every object-store key it renders onto the name the S3 client reads', async () => {
    const chart = await readFile(
      new URL('../../../../infra/helm/agent-workspace/templates/deployments.yaml', import.meta.url),
      'utf8',
    );
    const rendered = parseEnvironment(
      renderEnv({
        profile: defaultProfile({ cloud: 'aws', projectName: 'acme-ai' }),
        secrets,
        images: cloudImages,
        dockerGroupId: 0,
        projectName: 'acme-ai',
      }),
    );

    for (const [read, renderedName] of [
      ['AWS_ACCESS_KEY_ID', 'OBJECT_STORAGE_ACCESS_KEY_ID'],
      ['AWS_SECRET_ACCESS_KEY', 'OBJECT_STORAGE_SECRET_ACCESS_KEY'],
    ] as const) {
      expect(rendered, `the renderer no longer emits ${renderedName}`).toHaveProperty(renderedName);
      expect(
        chart,
        `the chart's Deployment does not set ${read} from the object-store Secret's ${renderedName}`,
      ).toMatch(
        new RegExp(
          `- name: ${read}\\s+valueFrom:\\s+secretKeyRef:\\s+name: [^\\n]+\\s+` +
            `key: ${renderedName}\\s+optional: true`,
          'u',
        ),
      );
    }
    // The Secret the mapping reads from is the one the chart's own values.yaml names.
    expect(chart).toContain('$.Values.external.objectStoreSecret');
  });

  it('puts the profile bootstrap administrator into the module variable that seeds the owner', () => {
    const azure = defaultProfile({ cloud: 'azure', projectName: 'a' });
    const rendered = renderTerraformVariables(
      { ...azure, identity: { bootstrapAdmin: 'ops@acme.example' } },
      images,
    );
    expect(JSON.parse(rendered?.contents ?? '{}')).toMatchObject({
      bootstrap_admin_email: 'ops@acme.example',
    });
  });
});
