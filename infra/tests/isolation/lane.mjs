/**
 * The two lanes of the isolation suite. A lane creates sandboxes through the real driver of
 * `packages/runtime` (built to `dist/`) and runs commands inside them, so a check can look at the
 * sandbox from the inside. Every child process runs without a shell.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import {
  createDockerDriver,
  createKubernetesDriver,
  dockerEgressNetworkName,
  dockerEgressOutNetworkName,
} from '../../../packages/runtime/dist/index.js';

const ENGINE = 'claude-agent-sdk';
const stubCommand = (port) => ['httpd', '-f', '-p', String(port), '-h', '/www'];
const STUB_PORT = 8080;
// The decoy listens on a port the proxy allows, so a proxied request to it is refused for its
// address and not merely for its port.
const DECOY_PORT = 80;

/** @returns {Promise<{ code: number; stdout: string; stderr: string }>} */
export function run(command, args, { input, timeoutMs = 120_000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], cwd, env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

async function ok(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed (${String(result.code)}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runSpec(driver, networkPolicy, { memoryMb, diskMb, timeoutSeconds, allowedDomains } = {}) {
  return {
    runtimeProfileId: 'isolation-suite',
    driver,
    networkPolicy,
    filesystem: 'read-write',
    ...(allowedDomains === undefined ? {} : { allowedDomains }),
    ...(memoryMb === undefined ? {} : { memoryMb }),
    ...(diskMb === undefined ? {} : { diskMb }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
}

const startAgent = () => {
  throw new Error('the isolation suite never starts an agent');
};

/**
 * A lane's `create(label, options)` takes `policy`: `open` and `restricted` (with `allowedDomains`)
 * go through the per-session egress proxy of ADR-0117; `none` (no egress the profile did not grant)
 * and `gateway` (egress to the gateway only) do not. Docker has no separate gateway mode: its
 * `none` is the internal network that carries the gateway, so both map to it.
 *
 * `lane.control` is a plain workload with unrestricted egress. It is the positive control for every
 * "unreachable" check: those only prove something if the target answers a sandbox with no policy.
 */
export async function createDockerLane({ image, proxyImage, id = randomBytes(3).toString('hex') }) {
  const networkName = `aw-iso-${id}`;
  const driver = createDockerDriver({
    images: new Map([[ENGINE, image]]),
    startAgent,
    command: ['sleep', '3600'],
    networkName,
    workspaceStorage: 'anonymous-volume',
    egressProxyImage: proxyImage,
  });
  // ADR-0118 TS2: tool sandboxes come from a second driver instance on a network of their own, as
  // the runner places them. The probe image stands in for the tool host image until the lane
  // builds it (#843); the placement, not the image, is what the network checks look at.
  const toolNetworkName = `${networkName}-tools`;
  const toolDriver = createDockerDriver({
    images: new Map([[ENGINE, image]]),
    startAgent,
    command: ['sleep', '3600'],
    networkName: toolNetworkName,
    workspaceStorage: 'anonymous-volume',
    egressProxyImage: proxyImage,
  });
  const docker = (...args) => ok('docker', args);
  const containers = new Set();
  const sandboxes = new Set();
  const ipOn = async (container, network) =>
    docker('inspect', '--format', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container);
  const startStub = async (name, network, port) => {
    await docker('run', '--detach', '--name', name, '--network', network, image, ...stubCommand(port));
    containers.add(name);
    return `http://${await ipOn(name, network)}:${String(port)}/`;
  };

  const lane = {
    name: 'docker',
    gatewayUrl: '',
    decoyUrl: '',
    control: undefined,

    async setup() {
      // The driver creates this network lazily, but the stub gateway has to be on it first. The
      // driver accepts it only if it is an internal bridge carrying its ownership label.
      for (const network of [networkName, toolNetworkName]) {
        await docker('network', 'create', '--driver', 'bridge', '--internal', '--label', 'agent-workspace.runtime=docker-network', network);
      }
      lane.gatewayUrl = await startStub(`${networkName}-gateway`, networkName, STUB_PORT);
      lane.decoyUrl = await startStub(`${networkName}-decoy`, 'bridge', DECOY_PORT);
      const control = `${networkName}-control`;
      await docker('run', '--detach', '--name', control, '--network', 'bridge', image);
      containers.add(control);
      lane.control = { exec: (argv, options) => run('docker', ['exec', control, ...argv], options) };
    },

    /** `tool: true` places the sandbox as a tool sandbox, through the tool driver. */
    async create(label, { policy, memoryMb, diskMb, timeoutSeconds, allowedDomains, tool = false } = {}) {
      const placement = tool ? toolDriver : driver;
      const handle = await placement.create({
        sessionId: `${networkName}-${label}`,
        workspacePath: `/isolation/${networkName}/${label}`,
        engine: ENGINE,
        runSpec: runSpec('docker', policy === 'open' || policy === 'restricted' ? policy : 'none', {
          memoryMb,
          diskMb,
          timeoutSeconds,
          allowedDomains,
        }),
      });
      const volumes = (
        await docker('inspect', '--format', '{{range .Mounts}}{{if .Name}}{{.Name}} {{end}}{{end}}', handle.externalId)
      )
        .split(/\s+/u)
        .filter(Boolean);
      const sandbox = {
        handle,
        driver: placement,
        volumes,
        exec: (argv, options) => run('docker', ['exec', handle.externalId, ...argv], options),
      };
      sandboxes.add(sandbox);
      return sandbox;
    },

    async destroy(sandbox) {
      await sandbox.driver.destroy(sandbox.handle);
      sandboxes.delete(sandbox);
    },

    inspect: (sandbox) => docker('inspect', sandbox.handle.externalId),

    /** The sandbox's address on the tool network, for a probe that must not reach it. */
    toolAddress: (sandbox) => ipOn(sandbox.handle.externalId, toolNetworkName),

    /** What the runner uses to hand a tool sandbox its secrets (ADR-0118 TS4). */
    writeFile: (sandbox, name, content) => sandbox.driver.writeFile(sandbox.handle, name, content),

    /** What a destroyed sandbox left behind: containers carrying its runtime id, and its volumes. */
    async leftovers(sandbox) {
      const left = [];
      const listed = await docker('ps', '--all', '--quiet', '--filter', `label=agent-workspace.runtime-id=${sandbox.handle.id}`);
      if (listed !== '') left.push(`container ${listed}`);
      for (const volume of sandbox.volumes) {
        if ((await run('docker', ['volume', 'inspect', volume])).code === 0) left.push(`volume ${volume}`);
      }
      for (const network of [dockerEgressNetworkName(sandbox.handle.id), dockerEgressOutNetworkName(sandbox.handle.id)]) {
        if ((await run('docker', ['network', 'inspect', network])).code === 0) left.push(`network ${network}`);
      }
      return left;
    },

    async teardown() {
      for (const sandbox of [...sandboxes]) await lane.destroy(sandbox).catch(() => {});
      for (const name of containers) await run('docker', ['rm', '--force', '--volumes', name]);
      await run('docker', ['network', 'rm', networkName, toolNetworkName]);
    },
  };
  return lane;
}

/**
 * The kind lane. With `manager` (`{ url, token, namespace }`, the chart's runner manager) the sandboxes are the
 * ones that manager allocates in the release namespace (#854), the way a real session gets its pod,
 * and the gateway is the chart's own. Without it the lane builds the driver itself and gives every
 * sandbox a namespace of its own, with a stub gateway.
 */
export async function createKindLane({ image, proxyImage, manager, id = randomBytes(3).toString('hex') }) {
  const gatewayNamespace = manager?.namespace ?? 'agent-workspace';
  const decoyNamespace = `aw-iso-decoy-${id}`;
  const driver =
    manager === undefined
      ? createKubernetesDriver({
          images: new Map([[ENGINE, image]]),
          startAgent,
          timeoutSeconds: 600,
          gatewayNamespace,
          gatewayService: 'gateway',
          egressProxyImage: proxyImage,
        })
      : undefined;
  const managerCall = async (method, route, body) => {
    const response = await fetch(`${manager.url}${route}`, {
      method,
      headers: { authorization: `Bearer ${manager.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(240_000),
    });
    const text = await response.text();
    if (!response.ok && response.status !== 404) {
      throw new Error(`runner manager ${method} ${route} answered ${String(response.status)}: ${text}`);
    }
    return { status: response.status, json: text === '' ? null : JSON.parse(text) };
  };
  const managed = manager !== undefined;
  const kubectl = (...args) => run('kubectl', args);
  const apply = (manifest) => ok('kubectl', ['apply', '-f', '-'], { input: JSON.stringify(manifest) });
  const sandboxes = new Set();
  let createdGatewayNamespace = false;

  const stubPod = (name, namespace, labels, port) => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace, labels },
    spec: {
      containers: [{ name: 'stub', image, command: stubCommand(port), ports: [{ containerPort: port }] }],
    },
  });
  const podIp = async (name, namespace) => {
    await ok('kubectl', ['wait', '--for=condition=Ready', `pod/${name}`, '-n', namespace, '--timeout=180s']);
    return ok('kubectl', ['get', 'pod', name, '-n', namespace, '-o', 'jsonpath={.status.podIP}']);
  };

  const lane = {
    name: managed ? 'kind-chart' : 'kind',
    gatewayUrl: '',
    decoyUrl: '',
    control: undefined,
    kubectl,

    async setup() {
      if (managed) {
        const clusterIp = await ok('kubectl', ['get', 'service', 'agent-workspace-gateway', '-n', gatewayNamespace, '-o', 'jsonpath={.spec.clusterIP}']);
        lane.gatewayUrl = `http://${clusterIp}:4000/health`;
        await lane.setupDecoy();
        return;
      }
      // The gateway is reached the way a real sandbox reaches it: by the ClusterIP of a Service
      // whose pod carries the label the driver's NetworkPolicy selects.
      const exists = (await kubectl('get', 'namespace', gatewayNamespace)).code === 0;
      if (!exists) {
        await ok('kubectl', ['create', 'namespace', gatewayNamespace]);
        createdGatewayNamespace = true;
      }
      await apply(stubPod(`aw-iso-gateway-${id}`, gatewayNamespace, { 'app.kubernetes.io/name': 'gateway' }, STUB_PORT));
      await apply({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: `aw-iso-gateway-${id}`, namespace: gatewayNamespace },
        spec: {
          selector: { 'app.kubernetes.io/name': 'gateway' },
          ports: [{ port: STUB_PORT, targetPort: STUB_PORT }],
        },
      });
      await ok('kubectl', ['wait', '--for=condition=Ready', `pod/aw-iso-gateway-${id}`, '-n', gatewayNamespace, '--timeout=180s']);
      const clusterIp = await ok('kubectl', ['get', 'service', `aw-iso-gateway-${id}`, '-n', gatewayNamespace, '-o', 'jsonpath={.spec.clusterIP}']);
      lane.gatewayUrl = `http://${clusterIp}:${String(STUB_PORT)}/`;

      await lane.setupDecoy();
    },

    async setupDecoy() {
      await ok('kubectl', ['create', 'namespace', decoyNamespace]);
      await apply(stubPod('decoy', decoyNamespace, { app: 'decoy' }, DECOY_PORT));
      lane.decoyUrl = `http://${await podIp('decoy', decoyNamespace)}:${String(DECOY_PORT)}/`;
      // No NetworkPolicy selects this namespace, so the pod has the cluster's unrestricted egress.
      await apply({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'control', namespace: decoyNamespace },
        spec: { containers: [{ name: 'control', image }] },
      });
      await podIp('control', decoyNamespace);
      lane.control = {
        exec: (argv, options) => run('kubectl', ['exec', '-n', decoyNamespace, 'control', '--', ...argv], options),
      };
    },

    async create(label, { policy, memoryMb, timeoutSeconds, allowedDomains } = {}) {
      const proxied = policy === 'open' || (policy === 'restricted' && (allowedDomains ?? []).length > 0);
      const sessionId = `aw-iso-${id}-${label}`;
      // Direct: with no run spec the driver applies its default, default-deny plus the gateway
      // exception; a limit or a deadline needs a run spec, and `restricted` without domains selects
      // that same default. The manager always takes a run spec, so there `gateway` is that default.
      const needsSpec = managed || policy !== 'gateway' || memoryMb !== undefined || timeoutSeconds !== undefined;
      const spec = needsSpec
        ? runSpec('kubernetes', policy === 'open' || policy === 'none' ? policy : 'restricted', { memoryMb, timeoutSeconds, allowedDomains })
        : undefined;
      let handle;
      if (managed) {
        handle = (await managerCall('POST', '/runtimes', { workspaceId: `aw-iso-${id}`, sessionId, engine: ENGINE, runSpec: spec })).json.handle;
      } else {
        handle = await driver.create({
          sessionId,
          workspacePath: `/isolation/${id}/${label}`,
          engine: ENGINE,
          ...(spec === undefined ? {} : { runSpec: spec }),
        });
      }
      const [namespace, pod] = handle.externalId.split('/');
      const sandbox = {
        handle,
        namespace,
        pod,
        exec: (argv, options) => run('kubectl', ['exec', '-n', namespace, pod, '-c', 'runtime', '--', ...argv], options),
      };
      sandboxes.add(sandbox);
      await ok('kubectl', ['wait', '--for=condition=Ready', `pod/${pod}`, '-n', namespace, '--timeout=180s']);
      if (proxied) {
        await ok('kubectl', ['wait', '--for=condition=Ready', `pod/egress-${pod}`, '-n', namespace, '--timeout=180s']);
      }
      // The CNI programs a pod's NetworkPolicy shortly after the pod is Ready; a negative network
      // check run before that would pass against an interface that is still open.
      await sleep(5_000);
      return sandbox;
    },

    async destroy(sandbox) {
      if (managed) await managerCall('DELETE', `/runtimes/${sandbox.handle.id}`);
      else await driver.destroy(sandbox.handle);
      sandboxes.delete(sandbox);
    },

    /**
     * Own namespace: it holds every resource the driver made, so waiting for it covers the pod.
     * Shared namespace: the pod, its proxy and their Services and policies are named after the pod.
     */
    async leftovers(sandbox, waitMs = 180_000) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const listed = managed
          ? await kubectl('get', 'pod,service,networkpolicy', '-n', sandbox.namespace, '-o', 'name')
          : await kubectl('get', 'namespace', sandbox.namespace, '--ignore-not-found', '-o', 'name');
        if (listed.code !== 0) return [`query failed: ${listed.stderr.trim()}`];
        const left = listed.stdout.split('\n').filter((name) => name !== '' && (!managed || name.includes(sandbox.pod)));
        if (left.length === 0) return [];
        if (Date.now() >= deadline) return left;
        await sleep(2_000);
      }
    },

    async teardown() {
      for (const sandbox of [...sandboxes]) await lane.destroy(sandbox).catch(() => {});
      await kubectl('delete', 'namespace', decoyNamespace, '--wait=false');
      if (managed) return;
      await kubectl('delete', 'pod,service', `aw-iso-gateway-${id}`, '-n', gatewayNamespace, '--wait=false');
      if (createdGatewayNamespace) await kubectl('delete', 'namespace', gatewayNamespace, '--wait=false');
    },
  };
  return lane;
}
