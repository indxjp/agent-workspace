/**
 * The sandbox side of the provider live lane. It stands in for the runner server at the path every
 * provider starts (`/srv/apps/runner/dist/index.js`), requires the same `RUNTIME_SANDBOX_BEARER`,
 * and answers `GET /ping` and `GET /probe`. `/probe` only reports: the uid it runs as and, for each
 * target, whether it was reached. The lane on the runner decides pass or fail.
 * A private IPv4 target that connects also gets one HTTP request, and the report carries only the byte
 * count, how the exchange ended and the numeric status, so the lane can tell a provider egress proxy that
 * accepts every TCP connect from a host that answers. 192.0.2.1 (TEST-NET-1) is never routed: if it
 * connects too, the connects are the provider's. Each of those addresses is tried a second time as
 * `<name>-fronted` with the gateway's Host header, so a proxy that filters on Host alone is caught.
 * When 169.254.169.254:80 connects, the report's `attempts.metadata.evidence` carries HTTP statuses
 * and the key names of the object an MMDS token flow returns. Tokens and values never leave this process.
 * It refuses to run without the bearer. On E2B the provider starts it after create through envd's
 * process API with the bearer in its environment, so the template has no start command.
 * Dependencies: none (Node stdlib), so the image is the production base plus this one file.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { fileURLToPath } from 'node:url';

const CONNECT_TIMEOUT_MS = 4_000;
const HOSTNAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/u;

// The ranges of ADR-0120 LC4 "always denied" that a sandbox can probe from the inside, plus the IPv6
// targets of `no-ipv6-egress`. IPv4 loopback is not among them: the sandbox's own 127.0.0.1 always
// answers. `::1:80` is included because nothing in the sandbox listens there (the probe binds IPv4
// only), so reaching it is a fail.
const FIXED_TARGETS = {
  metadata: ['169.254.169.254', 80],
  'link-local-2': ['169.254.169.253', 80],
  'ipv6-link-local': ['fe80::1', 80],
  'ipv6-ula': ['fc00::1', 80],
  'ipv6-loopback': ['::1', 80],
  'rfc1918-10': ['10.0.0.1', 80],
  'rfc1918-172': ['172.16.0.1', 80],
  'rfc1918-192': ['192.168.0.1', 80],
  cgnat: ['100.64.0.1', 80],
  'test-net': ['192.0.2.1', 80],
};
const EXCHANGE_TARGETS = ['rfc1918-10', 'rfc1918-172', 'rfc1918-192', 'cgnat', 'test-net'];

/**
 * `answered` only when the target was reached. A fixed address is reached on a TCP connect; a
 * refusal is not reached, because a firewall REJECT (ICMP unreachable or a reset) is how a
 * blocked range shows up. A hostname is reached only on a completed TLS handshake carrying its SNI,
 * because every provider allows the gateway by hostname and an SNI-filtering proxy accepts the TCP
 * connection before it sees the ClientHello. On Cloudflare `NODE_EXTRA_CA_CERTS` trusts the
 * intercept CA. With `exchange`, a TCP connect is followed by one HTTP/1.0 request and
 * `exchange: { bytes, end, status }` records what came back (`end`: close, reset or timeout; `status`:
 * the numeric status code, or null). `hostHeader` (default: `host`) is the request's Host header.
 * No response text is kept.
 */
export function attempt([host, port], { tls = false, servername = host, exchange = false, hostHeader = host } = {}) {
  return new Promise((resolve) => {
    const socket = tls ? connectTls({ host, port, servername }) : connect({ host, port });
    const done = (outcome, extra = {}) => {
      socket.destroy();
      resolve({ outcome, answered: outcome === 'connected', ...extra });
    };
    const talk = () => {
      let bytes = 0;
      let head = '';
      const finish = (end) => {
        const status = /^HTTP\/\d\.\d (\d{3})/u.exec(head)?.[1];
        done('connected', { exchange: { bytes, end, status: status === undefined ? null : Number(status) } });
      };
      socket.removeAllListeners('timeout');
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish('timeout'));
      socket.removeAllListeners('error');
      socket.once('error', () => finish('reset'));
      socket.on('data', (chunk) => {
        bytes += chunk.length;
        if (head.length < 16) head += chunk.toString('latin1', 0, 16);
      });
      socket.once('close', () => finish('close'));
      socket.write(`GET / HTTP/1.0\r\nHost: ${hostHeader}\r\n\r\n`);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done('timeout'));
    socket.once(tls ? 'secureConnect' : 'connect', exchange ? talk : () => done('connected'));
    socket.once('error', (error) => done(error.code === 'ECONNREFUSED' ? 'refused' : (error.code ?? 'error')));
  });
}

const tokenOf = ({ status, body }) => (status !== null && status >= 200 && status < 300 ? body.trim() : '');

async function request(base, method, path, headers = {}) {
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    return { status: response.status, headers: response.headers, body: await response.text() };
  } catch {
    return { status: null, headers: new Headers(), body: '' };
  }
}

/**
 * What answers HTTP at `base`, reduced to what the lane may record: statuses, whether a GCP
 * `Metadata-Flavor: Google` header came back, and the sorted key names of the object a Firecracker
 * MMDS token flow returns (`null` when the body is not a JSON object), and `flat`: whether every
 * top-level value of that object is a string (absent when it is not one). Tokens and values stay in
 * local variables; a failed request is `status: null`.
 */
export async function metadataEvidence(base) {
  const firecracker = async () => {
    const unauthenticated = await request(base, 'GET', '/');
    const token = await request(base, 'PUT', '/latest/api/token', { 'X-metadata-token-ttl-seconds': '60' });
    const tree = await request(base, 'GET', '/', { 'X-metadata-token': tokenOf(token), Accept: 'application/json' });
    let keys = null;
    let flat;
    try {
      const parsed = JSON.parse(tree.body);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        keys = Object.keys(parsed).sort();
        flat = Object.values(parsed).every((value) => typeof value === 'string');
      }
    } catch {
      // not JSON: keys stay null
    }
    return { unauthenticatedStatus: unauthenticated.status, tokenStatus: token.status, keys, flat };
  };
  const gcp = async () => {
    const response = await request(base, 'GET', '/computeMetadata/v1/', { 'Metadata-Flavor': 'Google' });
    return { status: response.status, flavor: response.headers.get('metadata-flavor') === 'Google' };
  };
  const imdsv2 = async () => {
    const token = await request(base, 'PUT', '/latest/api/token', { 'X-aws-ec2-metadata-token-ttl-seconds': '60' });
    const iam = await request(base, 'GET', '/latest/meta-data/iam/', {
      'X-aws-ec2-metadata-token': tokenOf(token),
      'X-metadata-token': tokenOf(token),
    });
    return { tokenStatus: token.status, iamStatus: iam.status };
  };
  const imdsv1 = async () => ({ iamStatus: (await request(base, 'GET', '/latest/meta-data/iam/')).status });
  const [mmds, gcpEvidence, imdsv2Evidence, imdsv1Evidence] = await Promise.all([firecracker(), gcp(), imdsv2(), imdsv1()]);
  return { ...mmds, gcp: gcpEvidence, imdsv2: imdsv2Evidence, imdsv1: imdsv1Evidence };
}

async function probe(url) {
  const targets = Object.entries(FIXED_TARGETS).map(([name, target]) => [name, target, { exchange: EXCHANGE_TARGETS.includes(name) }]);
  targets.push(['ipv6-public', ['2606:4700:4700::1111', 443], { tls: true, servername: 'one.one.one.one' }]);
  for (const name of ['gateway', 'public']) {
    const host = url.searchParams.get(name);
    if (host !== null && HOSTNAME.test(host)) targets.push([name, [host, 443], { tls: true }]);
  }
  // Domain fronting: a proxy that filters on Host and forwards to the original IP would pass the
  // gateway's Host through to the private address, so each exchange target is tried with it too.
  const gateway = url.searchParams.get('gateway');
  if (gateway !== null && HOSTNAME.test(gateway)) {
    for (const name of EXCHANGE_TARGETS) targets.push([`${name}-fronted`, FIXED_TARGETS[name], { exchange: true, hostHeader: gateway }]);
  }
  const entries = await Promise.all(targets.map(async ([name, target, options]) => [name, await attempt(target, options)]));
  const attempts = Object.fromEntries(entries);
  if (attempts.metadata.answered) attempts.metadata.evidence = await metadataEvidence('http://169.254.169.254');
  return { uid: process.getuid?.() ?? -1, attempts };
}

function authorizer(bearer) {
  const expected = createHash('sha256').update(`Bearer ${bearer}`).digest();
  return (header) => timingSafeEqual(createHash('sha256').update(header ?? '').digest(), expected);
}

function serve() {
  const bearer = process.env.RUNTIME_SANDBOX_BEARER ?? '';
  if (bearer === '') throw new Error('RUNTIME_SANDBOX_BEARER is required');
  const authorized = authorizer(bearer);

  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!authorized(req.headers.authorization)) return send(401, { error: 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://probe.invalid');
    if (req.method === 'GET' && url.pathname === '/ping') return send(200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/probe') {
      return probe(url).then(
        (report) => send(200, report),
        () => send(500, { error: 'probe_failed' }),
      );
    }
    return send(404, { error: 'not_found' });
  });

  server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '0.0.0.0');
}

// Run as the server only when started as the entry point, so unit tests can import `attempt`.
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  serve();
}
