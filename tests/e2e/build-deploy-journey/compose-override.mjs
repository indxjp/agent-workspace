import path from 'node:path';

import { FAKE_PROVIDER_HOST } from '../../generated-project/project.mjs';
import { ROOT } from './journey-support.mjs';

/** The Compose override for the single-vm state directory; not part of what `aw deploy` writes. */
export function composeOverride({
  project,
  nodeImage,
  controlPort,
  fixture,
  toolHost,
  egressProxy,
}) {
  const sandbox = `      AGENT_WORKSPACE_TOOL_HOST_IMAGE: ${toolHost}
      AGENT_WORKSPACE_EGRESS_PROXY_IMAGE: ${egressProxy}`;
  // The extra environment goes before `volumes:`, inside the `environment:` mapping.
  const trust = (extraEnvironment = '') => `      EGRESS_ALLOW_HOSTS: ${FAKE_PROVIDER_HOST}
      NODE_EXTRA_CA_CERTS: /e2e/ca.pem${extraEnvironment}
    volumes:
      - ${fixture}/ca.pem:/e2e/ca.pem:ro
    depends_on:
      fake-anthropic: { condition: service_healthy }`;
  return `# Written by tests/e2e/build-deploy-journey/journey.e2e.mjs; not part of the deployment.
# The tool sandbox and the fake provider are not in the single-vm template yet.
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
      provider-egress: { aliases: [${FAKE_PROVIDER_HOST}] }
      web-ingress: { aliases: [${FAKE_PROVIDER_HOST}] }
  gateway:
    environment:
${trust()}
    networks: [tool-sandbox]
  web:
    environment:
${trust(`\n${sandbox}`)}
  runner:
    environment:
${sandbox}
      AGENT_WORKSPACE_TOOL_NETWORK: ${project}-tool-sandbox
      RUNTIME_PROXY_BYPASS: gateway
    networks: [tool-sandbox]
networks:
  tool-sandbox:
    name: ${project}-tool-sandbox
    internal: true
    attachable: true
    labels:
      agent-workspace.runtime: docker-network
`;
}
