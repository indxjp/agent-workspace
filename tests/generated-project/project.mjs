/* global console, setTimeout, clearTimeout */
/**
 * The generated project's lifecycle for the generated-project E2E: create it with the packed
 * generator, install its CLI from this change's tarball, add the fake Anthropic provider, start it,
 * and account for everything it leaves behind after teardown.
 *
 * The pure parts (output parsing, the Compose override, the leftover classification) are exported
 * for `project.test.ts`; the rest shells out to `npm`, `pnpm`, `docker` and `openssl`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** The hostname the fake provider answers to: the provider default every new user's setup uses. */
export const FAKE_PROVIDER_HOST = 'api.anthropic.com';

/** Where the fake provider's files are mounted inside its container and in `web` and `gateway`. */
const FIXTURE_MOUNT = '/e2e';

/** The directory, inside the generated project, that holds the fake provider's script and TLS. */
export const FIXTURE_DIRECTORY = '.e2e';

/**
 * The administrator `create` prints. The password is the generated one-time setup password a new
 * user copies from the terminal; the E2E signs in with exactly that.
 *
 * @param {string} output
 */
export function parseCreateOutput(output) {
  const email = /^Administrator: (\S+)$/mu.exec(output)?.[1];
  const password = /^One-time setup password: (\S+)$/mu.exec(output)?.[1];
  const next = /^Next: (.+)$/mu.exec(output)?.[1];
  if (email === undefined || password === undefined || next === undefined) {
    throw new Error(`create printed no administrator, password or next step:\n${output}`);
  }
  return { adminEmail: email, adminPassword: password, nextStep: next };
}

/** @param {string} contents a `.env` document */
export function parseDotEnv(contents) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line.trim());
    if (match?.[1] !== undefined) values[match[1]] = match[2] ?? '';
  }
  return values;
}

/**
 * The `pnpm-workspace.yaml` `overrides` that make the generated project install the packed
 * `@indx-workspace/*` tarballs instead of the registry's: the project depends on the CLI by version,
 * and that version may not be published yet, or may be published from other source.
 *
 * @param {string} workspaceYaml the generated `pnpm-workspace.yaml`
 * @param {Readonly<Record<string, string>>} tarballs package name to absolute tarball path
 */
export function withTarballOverrides(workspaceYaml, tarballs) {
  if (/^overrides:/mu.test(workspaceYaml)) {
    throw new Error('the generated pnpm-workspace.yaml already declares overrides');
  }
  const entries = Object.entries(tarballs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, file]) => `  '${name}': 'file:${file.split(path.sep).join('/')}'`);
  return `${workspaceYaml.trimEnd()}\noverrides:\n${entries.join('\n')}\n`;
}

/**
 * The `compose.override.yaml` that adds the fake provider to the generated project. Compose merges
 * it with the generated `compose.yaml` because `agent-workspace start` runs `docker compose up`
 * with no `-f`; nothing in the generated `compose.yaml` or `.env` is edited.
 *
 * - `fake-anthropic` joins `provider-egress` (the gateway's way out) and `web-ingress` (the web
 *   service's), answering to `api.anthropic.com` on both, and publishes its control port on the
 *   Docker host's loopback only.
 * - `web` and `gateway` trust the test CA (`NODE_EXTRA_CA_CERTS`) and exempt that one host from the
 *   private-range egress check (`EGRESS_ALLOW_HOSTS`, `packages/core/src/net/egress-policy.ts`); the
 *   HTTPS requirement still holds, which is why the fake serves TLS.
 *
 * @param {{ nodeImage: string, controlPort: number }} options
 */
export function composeOverride({ nodeImage, controlPort }) {
  const trust = [
    `      EGRESS_ALLOW_HOSTS: ${FAKE_PROVIDER_HOST}`,
    `      NODE_EXTRA_CA_CERTS: ${FIXTURE_MOUNT}/ca.pem`,
  ].join('\n');
  const mount = `      - ./${FIXTURE_DIRECTORY}/ca.pem:${FIXTURE_MOUNT}/ca.pem:ro`;
  const dependsOn = '      fake-anthropic: { condition: service_healthy }';
  return `# Written by tests/generated-project (the generated-project E2E); not part of a generated project.
services:
  fake-anthropic:
    image: ${nodeImage}
    command: [node, ${FIXTURE_MOUNT}/fake-anthropic.mjs]
    environment:
      FAKE_ANTHROPIC_TLS_CERT: ${FIXTURE_MOUNT}/${FAKE_PROVIDER_HOST}.pem
      FAKE_ANTHROPIC_TLS_KEY: ${FIXTURE_MOUNT}/${FAKE_PROVIDER_HOST}.key
    volumes:
      - ./${FIXTURE_DIRECTORY}:${FIXTURE_MOUNT}:ro
    ports: ['127.0.0.1:${String(controlPort)}:8081']
    healthcheck:
      test:
        [
          CMD,
          node,
          -e,
          "fetch('http://127.0.0.1:8081/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 2s
      timeout: 3s
      retries: 30
    networks:
      provider-egress: { aliases: [${FAKE_PROVIDER_HOST}] }
      web-ingress: { aliases: [${FAKE_PROVIDER_HOST}] }
  gateway:
    environment:
${trust}
    volumes:
${mount}
    depends_on:
${dependsOn}
  web:
    environment:
${trust}
    volumes:
${mount}
    depends_on:
${dependsOn}
`;
}

/**
 * Write the fake provider's script, a throwaway CA and a certificate for `api.anthropic.com` that
 * it signed into `<project>/.e2e`. The keys are generated per run and never leave the machine.
 *
 * @param {string} projectDirectory @param {string} fakeScript
 */
export function writeFakeProviderFixture(projectDirectory, fakeScript) {
  const directory = path.join(projectDirectory, FIXTURE_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  copyFileSync(fakeScript, path.join(directory, 'fake-anthropic.mjs'));
  const openssl = (/** @type {string[]} */ args) => run('openssl', args, { cwd: directory });
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=agent-workspace e2e CA',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign',
  ]);
  const host = FAKE_PROVIDER_HOST;
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    `/CN=${host}`,
    '-keyout',
    `${host}.key`,
    '-out',
    `${host}.csr`,
  ]);
  writeFileSync(
    path.join(directory, 'leaf.ext'),
    `subjectAltName=DNS:${host}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n`,
  );
  openssl([
    'x509',
    '-req',
    '-in',
    `${host}.csr`,
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '2',
    '-extfile',
    'leaf.ext',
    '-out',
    `${host}.pem`,
  ]);
  // The fake runs as root in its container, the files only need to be readable there.
  for (const file of ['ca.pem', `${host}.pem`, `${host}.key`]) {
    run('chmod', ['0644', path.join(directory, file)]);
  }
}

/**
 * Run a command to completion and return its stdout; throw with both streams on a non-zero exit.
 *
 * @param {string} command @param {readonly string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string, timeoutMs?: number }} [options]
 */
export function run(command, args, options = {}) {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input ?? '',
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${String(result.status ?? result.signal)}\n` +
        `${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout;
}

/**
 * Run a command, streaming its output to this process while also collecting it, and resolve with
 * the exit status. For `pnpm start`, whose progress is worth seeing in a CI log.
 *
 * @param {string} command @param {readonly string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, timeoutMs: number }} options
 * @returns {Promise<{ status: number | null, output: string }>}
 */
export function runStreaming(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (/** @type {Buffer} */ chunk) => {
      process.stdout.write(chunk);
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

/**
 * @typedef {{ id: string, name: string, labels: Record<string, string>, networks: string[] }} Leftover
 * @typedef {{ containers: Leftover[], networks: string[] }} Leftovers
 */

/** @param {string} value a `docker ps --format '{{.Labels}}'` value */
function parseLabels(value) {
  /** @type {Record<string, string>} */
  const labels = {};
  for (const pair of value.split(',')) {
    const separator = pair.indexOf('=');
    if (separator > 0) labels[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return labels;
}

/**
 * Everything of the Compose project `projectName` in a `docker ps` and `docker network ls`
 * listing: containers Compose labelled as the project's, runtime sandboxes
 * (`agent-workspace.runtime=docker`, `packages/runtime/src/docker.ts`) that carry the project's
 * `agent-workspace.compose-project` label or are attached to one of its networks, and networks it
 * named.
 *
 * @param {string} projectName
 * @param {string} psListing `docker ps --format '{{.ID}}\t{{.Names}}\t{{.Labels}}\t{{.Networks}}'`
 * @param {string} networkListing `docker network ls --format '{{.Name}}'`
 * @returns {Leftovers}
 */
export function leftoversOf(projectName, psListing, networkListing) {
  const ofProject = (/** @type {string} */ network) =>
    network.startsWith(`${projectName}-`) || network.startsWith(`${projectName}_`);
  /** @type {Leftover[]} */
  const containers = [];
  for (const line of psListing.split('\n')) {
    if (line.trim() === '') continue;
    const [id = '', name = '', labels = '', networks = ''] = line.split('\t');
    const parsed = parseLabels(labels);
    const attached = networks.split(',').filter((network) => network !== '');
    const composed = parsed['com.docker.compose.project'] === projectName;
    const sandbox =
      parsed['agent-workspace.runtime'] === 'docker' &&
      (parsed['agent-workspace.compose-project'] === projectName || attached.some(ofProject));
    if (composed || sandbox) containers.push({ id, name, labels: parsed, networks: attached });
  }
  const networks = networkListing
    .split('\n')
    .map((name) => name.trim())
    .filter(ofProject);
  return { containers, networks };
}

/**
 * {@link leftoversOf} the Docker host, now.
 *
 * @param {string} projectName
 * @returns {Leftovers}
 */
export function projectLeftovers(projectName) {
  return leftoversOf(
    projectName,
    run('docker', [
      'ps',
      '--all',
      '--no-trunc',
      '--format',
      '{{.ID}}\t{{.Names}}\t{{.Labels}}\t{{.Networks}}',
    ]),
    run('docker', ['network', 'ls', '--format', '{{.Name}}']),
  );
}

/**
 * Remove whatever of the project is still on the host, volumes included: the E2E's own cleanup,
 * after its assertions, so that a failed run leaves the host as it found it. Best effort, but every
 * failure is printed.
 *
 * @param {string} projectDirectory @param {string} projectName
 */
export function removeProject(projectDirectory, projectName) {
  const attempt = (/** @type {string[]} */ args, /** @type {string | undefined} */ cwd) => {
    const result = spawnSync('docker', args, { cwd, encoding: 'utf8', timeout: 180_000 });
    if (result.status !== 0) console.error(`cleanup: docker ${args.join(' ')}: ${result.stderr}`);
  };
  attempt(['compose', 'down', '--volumes', '--remove-orphans', '--timeout', '5'], projectDirectory);
  const { containers, networks } = projectLeftovers(projectName);
  if (containers.length > 0)
    attempt(['rm', '--force', '--volumes', ...containers.map((c) => c.id)]);
  if (networks.length > 0) attempt(['network', 'rm', ...networks]);
}

/** @param {string} file */
export function readEnvironmentFile(file) {
  return parseDotEnv(readFileSync(file, 'utf8'));
}
