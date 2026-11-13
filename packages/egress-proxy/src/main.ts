import process from 'node:process';

import { loadProxyConfig } from './config.js';
import { createEgressProxy } from './proxy.js';

const SHUTDOWN_GRACE_MS = 10_000;

try {
  const { mode, config } = loadProxyConfig(process.env);
  const server = createEgressProxy({
    ...(mode === 'shared'
      ? { credentialKey: config.credentialKey }
      : { sessionId: config.sessionId, allowlist: config.allowlist }),
    ...(config.allowedPorts === undefined ? {} : { allowedPorts: config.allowedPorts }),
  });
  server.listen(config.port, config.host);
  // An open tunnel keeps close() waiting, so the grace period ends in a hard exit.
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  });
} catch (error) {
  process.stderr.write(`egress-proxy: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
