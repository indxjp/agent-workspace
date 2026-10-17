import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('web container persistent storage', () => {
  it('owns every workspace-data directory before dropping to the node user', () => {
    const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    const webStart = dockerfile.indexOf('FROM runtime-base AS web');
    const runnerStart = dockerfile.indexOf('FROM runtime-base AS runner');
    const webStage = dockerfile.slice(webStart, runnerStart);
    const ownership = webStage.indexOf('RUN install -d -o node -g node');
    const nonRoot = webStage.indexOf('USER node');

    expect(webStart).toBeGreaterThanOrEqual(0);
    expect(runnerStart).toBeGreaterThan(webStart);
    expect(ownership).toBeGreaterThanOrEqual(0);
    expect(nonRoot).toBeGreaterThan(ownership);
    for (const directory of ['files', 'skills', 'sessions']) {
      expect(webStage).toContain(`/var/lib/agent-workspace/${directory}`);
    }
  });
});

describe('runner-manager container prerequisites', () => {
  it('installs the Docker CLI before dropping privileges', () => {
    const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    const runnerStart = dockerfile.indexOf('FROM runtime-base AS runner');
    const runnerStage = dockerfile.slice(runnerStart);
    // Only the client, from Docker's static release, checksum-verified per architecture (#373).
    const checksums = ['DOCKER_CLI_SHA256_AMD64', 'DOCKER_CLI_SHA256_ARM64'].map((name) =>
      runnerStage.indexOf(`ADD --checksum=sha256:\${${name}}`),
    );
    const dockerCli = runnerStage.indexOf(
      'tar -xzf "/tmp/docker-${TARGETARCH}.tgz" -C /usr/local/bin --strip-components=1 docker/docker',
    );
    const nonRoot = runnerStage.indexOf('USER node');

    expect(runnerStart).toBeGreaterThanOrEqual(0);
    expect(runnerStage).toMatch(/^ARG DOCKER_CLI_SHA256_AMD64=[0-9a-f]{64}$/mu);
    expect(runnerStage).toMatch(/^ARG DOCKER_CLI_SHA256_ARM64=[0-9a-f]{64}$/mu);
    expect(runnerStage).not.toMatch(/apt-get install[^\n]*docker\.io/u);
    for (const checksum of checksums) {
      expect(checksum).toBeGreaterThanOrEqual(0);
      expect(dockerCli).toBeGreaterThan(checksum);
    }
    expect(dockerCli).toBeGreaterThanOrEqual(0);
    expect(nonRoot).toBeGreaterThan(dockerCli);
  });

  it('joins the mounted Docker socket group in the local Compose deployment', () => {
    const compose = readFileSync(path.join(root, 'compose.yaml'), 'utf8');
    const runnerStart = compose.indexOf('  runner:');
    const gatewayStart = compose.indexOf('  gateway:', runnerStart);
    const runnerService = compose.slice(runnerStart, gatewayStart);

    expect(runnerStart).toBeGreaterThanOrEqual(0);
    expect(gatewayStart).toBeGreaterThan(runnerStart);
    expect(runnerService).toContain('- /var/run/docker.sock:/var/run/docker.sock');
    expect(runnerService).toContain('- ${DOCKER_GID:-0}');
  });
});
