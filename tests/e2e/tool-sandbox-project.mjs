import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FAKE_PROVIDER_HOST, parseDotEnv } from '../generated-project/project.mjs';
import { AGENT, DECLARATION, RUN_FILE } from './tool-sandbox-fixtures.mjs';
export {
  TOOL_HOST_URL,
  TOOL_NAME,
  DECLARED_SECRET,
  ALLOWED_HOST,
  DECLARATION,
  OFFLINE_DECLARATION,
  OFFLINE_RUN_FILE,
  RUN_FILE,
} from './tool-sandbox-fixtures.mjs';

export const ROOT = path.resolve(import.meta.dirname, '../..');

export const PROJECT = 'aw-tool-sandbox-e2e';

export const AW_BIN = path.join(ROOT, 'packages/aw/dist/index.js');

export const PROVIDER_SCRIPT = path.join(import.meta.dirname, 'tool-sandbox-provider.mjs');

/**
 * The `AW_STORAGE_URL` `.env.example` gives the bundled SeaweedFS, which `compose.yaml` requires.
 * Read from that file so the e2e stack and a copied `.env` name the same store.
 *
 * @param {string} [root] the checkout holding `.env.example`
 */
export function bundledStorageUrl(root = ROOT) {
  const url = parseDotEnv(readFileSync(path.join(root, '.env.example'), 'utf8'))['AW_STORAGE_URL'];
  if (url === undefined || url === '') throw new Error('.env.example sets no AW_STORAGE_URL');
  return url;
}

/**
 * The `--env-file` the e2e brings `compose.yaml` up with.
 *
 * @param {{ adminEmail: string, adminPassword: string, webPort: number, dockerGid: number, storageUrl: string }} options
 */
export function stackEnv({ adminEmail, adminPassword, webPort, dockerGid, storageUrl }) {
  return [
    'DATABASE_URL=postgres://agent_workspace:agent_workspace@postgres:5432/agent_workspace',
    `MASTER_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
    `AW_STORAGE_URL=${storageUrl}`,
    'OBJECT_STORAGE_ACCESS_KEY_ID=agent_workspace',
    'OBJECT_STORAGE_SECRET_ACCESS_KEY=agent_workspace',
    `BOOTSTRAP_ADMIN=${adminEmail}`,
    `BOOTSTRAP_ADMIN_PASSWORD=${adminPassword}`,
    `SESSION_SECRET=${randomBytes(24).toString('hex')}`,
    `RUNNER_MANAGER_TOKEN=${randomBytes(24).toString('hex')}`,
    'GATEWAY_PRICING_JSON={"version":"unconfigured","models":{"disabled:unconfigured":{"inputUsdPerMillion":"0","outputUsdPerMillion":"0"}}}',
    'TOOL_HOST_IMAGE=agent-workspace/tool-host:dev',
    `WEB_PORT=${String(webPort)}`,
    `DOCKER_GID=${String(dockerGid)}`,
    '',
  ].join('\n');
}

export function composeOverride({ nodeImage, controlPort, fixture, gatewaySecret }) {
  // The web service derives the tool sandbox's bearer from this secret and the gateway recomputes
  // it (ADR-0118 TS3); the E2E supplies it so it can look for that bearer itself.
  const trust = `      EGRESS_ALLOW_HOSTS: ${FAKE_PROVIDER_HOST}
      NODE_EXTRA_CA_CERTS: /e2e/ca.pem
      GATEWAY_TOKEN_SECRET: ${gatewaySecret}
    volumes:
      - ${fixture}/ca.pem:/e2e/ca.pem:ro
    depends_on:
      fake-anthropic: { condition: service_healthy }`;
  return `# Written by tests/e2e/tool-sandbox.e2e.mjs; not part of the deployment.
services:
  fake-anthropic:
    image: ${nodeImage}
    command: [node, /repo/tests/e2e/tool-sandbox-provider.mjs]
    environment:
      FAKE_ANTHROPIC_TLS_CERT: /e2e/${FAKE_PROVIDER_HOST}.pem
      FAKE_ANTHROPIC_TLS_KEY: /e2e/${FAKE_PROVIDER_HOST}.key
    volumes:
      - ${fixture}:/e2e:ro
      - ${path.join(ROOT, 'tests')}:/repo/tests:ro
    ports: ['127.0.0.1:${String(controlPort)}:8081']
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:8081/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 2s
      timeout: 3s
      retries: 30
    networks:
      agent-workspace: { aliases: [${FAKE_PROVIDER_HOST}] }
  gateway:
    environment:
${trust}
  web:
    environment:
${trust}
  # Nothing here reaches SeaweedFS from the host, and another project on the daemon may hold 8333.
  seaweedfs:
    ports: !reset []
networks:
  # The runner only attaches runtime networks that carry the ownership label.
  runtime-control:
    labels:
      agent-workspace.runtime: docker-network
`;
}

export async function writeToolProject(work) {
  // The project: one agent, one code tool. The SDK is linked from this checkout, as a user's
  // node_modules would hold it.
  const project = path.join(work, 'project');
  mkdirSync(path.join(project, 'agents'), { recursive: true });
  mkdirSync(path.join(project, 'tools'), { recursive: true });
  mkdirSync(path.join(project, 'node_modules/@indx-workspace'), { recursive: true });
  for (const name of ['sdk', 'contracts']) {
    symlinkSync(
      path.join(ROOT, 'packages', name),
      path.join(project, 'node_modules/@indx-workspace', name),
    );
  }
  writeFileSync(
    path.join(project, 'package.json'),
    '{ "name": "tool-sandbox-e2e", "type": "module" }\n',
  );
  writeFileSync(path.join(project, 'agents/assistant.ts'), AGENT);
  writeFileSync(path.join(project, 'tools/get-order.ts'), DECLARATION);
  writeFileSync(path.join(project, 'tools/get-order.run.ts'), RUN_FILE);

  return project;
}
