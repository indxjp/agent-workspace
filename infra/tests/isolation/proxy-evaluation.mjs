/**
 * Judging the shared egress proxy's probes. Pure: every function maps raw proxy attempts (see
 * proxy-attempts.mjs) to lane results. A refusal from the proxy is a 403 (a 407 for a credential
 * refusal) whose body is `{"error":"egress_denied", ...}`, for CONNECT and for absolute-URI forward
 * requests alike. No detail below ever carries the proxy URL, the token or a header: only host:port
 * and the outcome.
 */
import { SECURITY_PREFIX, blindResult, result } from './lane-result.mjs';
import { evaluateSilent } from './probe-evaluation.mjs';

/** @typedef {import('./probe-evaluation.mjs').Attempt} Attempt */

/**
 * @typedef {Attempt & { body?: string; tls?: boolean }} ProxyAttempt
 * One request through the proxy: `status` and `body` are the proxy's (or the target's) answer, `tls`
 * is true once a TLS handshake with the target completed through a CONNECT tunnel.
 */

/** @param {string | undefined} body */
function isEgressDenied(body) {
  if (body === undefined) return false;
  try {
    const parsed = JSON.parse(body);
    return parsed !== null && typeof parsed === 'object' && parsed.error === 'egress_denied';
  } catch {
    return false;
  }
}

/**
 * What one request through the proxy proves. Pure.
 *
 *   refused   the proxy answered with the egress_denied body, at any status (403, 407, 502, 400: its own refusal);
 *   answered  anything a target could have produced: a 200 tunnel, a completed TLS handshake, or any
 *             status without the egress_denied body (a forwarded 403 is not a refusal);
 *   silent    no response at all before the timeout, so nothing came back from the target;
 *   unclear   anything else (the proxy refused the connection or reset it, a DNS or local error):
 *             never a pass, because a dead or broken proxy proves nothing about the policy, and never
 *             a fail, because no target answered. It is inconclusive, which fails the lane.
 *
 * @param {ProxyAttempt} attempt
 * @returns {'refused' | 'answered' | 'silent' | 'unclear'}
 */
export function classifyProxyAttempt(attempt) {
  if (attempt.tls === true) return 'answered';
  if (typeof attempt.status === 'number') {
    return isEgressDenied(attempt.body) ? 'refused' : 'answered';
  }
  return attempt.timedOut === true ? 'silent' : 'unclear';
}

/** @param {ProxyAttempt} attempt */
function describeProxyAttempt(attempt) {
  const kind = classifyProxyAttempt(attempt);
  if (kind === 'refused') return `refused ${String(attempt.status)} egress_denied`;
  if (attempt.tls === true) return 'TLS handshake completed';
  if (kind === 'answered') return `answered ${String(attempt.status)}`;
  // Whether the TCP connection to the proxy opened tells a dead or unreachable proxy (a firewall drop,
  // no listener behind the VM's host firewall) from a proxy that accepted and then stalled.
  if (kind === 'silent') {
    return `no response before the timeout (${attempt.connected === true ? 'TCP to the proxy connected' : 'no TCP connection to the proxy'})`;
  }
  return `no usable answer (${attempt.code ?? 'no code'})`;
}

const describeAll = (attempts) =>
  Object.entries(attempts)
    .map(([name, attempt]) => `${name} ${describeProxyAttempt(attempt)}`)
    .join(', ');

/**
 * Attempts at destinations the proxy must refuse: a pass only when every one was refused by the proxy
 * or got no response at all. Any answer from a target is a `SECURITY:` fail.
 *
 * @param {string} title @param {string} target @param {Record<string, ProxyAttempt>} attempts
 */
function evaluateDenied(title, target, attempts) {
  const all = Object.values(attempts).map(classifyProxyAttempt);
  const seen = describeAll(attempts);
  if (all.length === 0) return result(title, 'inconclusive', `no probe of ${target} ran`);
  if (all.includes('answered'))
    return result(
      title,
      'fail',
      `${SECURITY_PREFIX} the proxy let a request reach ${target} (${seen})`,
    );
  if (all.includes('unclear')) {
    return result(
      title,
      'inconclusive',
      `only a proxy refusal or no response proves the deny (${seen})`,
    );
  }
  return result(title, 'pass', seen);
}

/**
 * The positive control: through the proxy the listed (or public) host must really answer, by a forward
 * request (2xx or 3xx that is not a proxy refusal) and by a CONNECT tunnel with a TLS handshake.
 *
 * @param {string} title @param {ProxyAttempt} forward @param {ProxyAttempt} tunnel
 */
function evaluateControl(title, forward, tunnel) {
  const forwardOk =
    typeof forward.status === 'number' &&
    forward.status >= 200 &&
    forward.status < 400 &&
    !isEgressDenied(forward.body);
  const tunnelOk = tunnel.tls === true;
  const seen = `forward ${describeProxyAttempt(forward)}, CONNECT ${describeProxyAttempt(tunnel)}`;
  return result(title, forwardOk && tunnelOk ? 'pass' : 'fail', seen);
}

const blind = (title) =>
  blindResult(title, 'the positive control failed, so the proxy path is not proven to work at all');

/**
 * The restricted sandbox's results. Pure. When the listed-host control fails, every security result
 * is inconclusive.
 *
 * @param {{
 *   listedForward: ProxyAttempt;
 *   listedConnect: ProxyAttempt;
 *   unlisted: Record<string, ProxyAttempt>;
 *   direct: Record<string, Attempt>;
 *   noCredential: Record<string, ProxyAttempt>;
 * }} raw
 */
export function evaluateProxyRestricted(raw) {
  const listedTitle = 'A restricted sandbox reaches a listed host through the proxy';
  const unlistedTitle = 'A restricted sandbox is refused an unlisted host by the proxy';
  const directTitle = 'A restricted sandbox cannot bypass the proxy with a direct socket';
  const credentialTitle = 'The proxy refuses a request with no credential or a forged one';
  const listed = evaluateControl(listedTitle, raw.listedForward, raw.listedConnect);
  if (listed.outcome !== 'pass') {
    return {
      'proxy-listed-host': listed,
      'proxy-unlisted-host': blind(unlistedTitle),
      'proxy-direct-bypass': blind(directTitle),
      'proxy-no-credential': blind(credentialTitle),
    };
  }
  return {
    'proxy-listed-host': listed,
    'proxy-unlisted-host': evaluateDenied(unlistedTitle, 'an unlisted host', raw.unlisted),
    'proxy-direct-bypass': evaluateSilent(
      directTitle,
      'the public host without the proxy',
      raw.direct,
    ),
    'proxy-no-credential': evaluateCredential(credentialTitle, raw.noCredential),
  };
}

/**
 * A request without a valid credential must be a 407 egress_denied refusal from the proxy. Silence is
 * not enough here (the proxy must say why), and a 403 refusal is the wrong refusal.
 *
 * @param {string} title @param {Record<string, ProxyAttempt>} attempts
 */
function evaluateCredential(title, attempts) {
  const entries = Object.values(attempts);
  const seen = describeAll(attempts);
  if (entries.length === 0)
    return result(title, 'inconclusive', 'no probe without a valid credential ran');
  if (entries.some((attempt) => classifyProxyAttempt(attempt) === 'answered')) {
    return result(
      title,
      'fail',
      `${SECURITY_PREFIX} the proxy served a request without a valid credential (${seen})`,
    );
  }
  if (
    entries.some((attempt) => classifyProxyAttempt(attempt) === 'refused' && attempt.status !== 407)
  ) {
    return result(title, 'fail', `a credential refusal must be a 407 (${seen})`);
  }
  if (entries.some((attempt) => classifyProxyAttempt(attempt) !== 'refused')) {
    return result(
      title,
      'inconclusive',
      `only a 407 egress_denied refusal proves the credential check (${seen})`,
    );
  }
  return result(title, 'pass', seen);
}

/**
 * The open sandbox's results. Pure. Every destination that is not the public internet must be refused
 * by the proxy or get no response; the public host is the positive control.
 *
 * @param {{
 *   publicForward: ProxyAttempt;
 *   publicConnect: ProxyAttempt;
 *   privateTarget: Record<string, ProxyAttempt>;
 *   metadata: Record<string, ProxyAttempt>;
 *   googleVip: Record<string, ProxyAttempt>;
 *   gatewayIlb: Record<string, ProxyAttempt>;
 * }} raw
 */
export function evaluateProxyOpen(raw) {
  const publicTitle = 'An open sandbox reaches a public host through the proxy';
  const titles = {
    'proxy-private-target': 'The proxy refuses an open sandbox the private ranges',
    'proxy-metadata': 'The proxy refuses an open sandbox the metadata server',
    'proxy-google-vip': 'The proxy refuses an open sandbox the Google VIPs',
    'proxy-gateway-ilb': "The proxy refuses an open sandbox the gateway's internal load balancer",
  };
  const control = evaluateControl(publicTitle, raw.publicForward, raw.publicConnect);
  const checks = {
    'proxy-private-target': ['a private address', raw.privateTarget],
    'proxy-metadata': ['the metadata server', raw.metadata],
    'proxy-google-vip': ['a Google VIP', raw.googleVip],
    'proxy-gateway-ilb': ['the gateway load balancer', raw.gatewayIlb],
  };
  const results = { 'proxy-public-host': control };
  for (const [id, [target, attempts]] of Object.entries(checks)) {
    results[id] =
      control.outcome === 'pass' ? evaluateDenied(titles[id], target, attempts) : blind(titles[id]);
  }
  return results;
}
