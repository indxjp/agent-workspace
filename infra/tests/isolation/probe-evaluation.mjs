/**
 * Judging the sandbox network probes. Pure: every function maps raw attempts (see attempts.mjs) to
 * lane results and does no I/O. The agent sandbox's `probe`, the tool sandbox's `tool-call` and the
 * `token` mode all judge their measurements here.
 */
import { SENSITIVE_PERMISSIONS } from './attempts.mjs';
import { SECURITY_PREFIX, blindResult, result } from './lane-result.mjs';

export const GATEWAY_CONTROL_FAILED =
  'the gateway control failed, so the sandbox network is not proven to work at all';

export const METADATA_TITLE = 'The sandbox metadata token has no permissions';

/**
 * @typedef {{ status?: number; error?: string; code?: string; connected?: boolean; timedOut?: boolean }} Attempt
 * One network attempt: `status` is the HTTP status when one came back, `connected` is true once the
 * TCP connection opened, `timedOut` is true when the attempt ended on its timeout, and `code` is the
 * Node error code.
 */

// Codes that prove a packet came back from the far end: a refusal, a reset, a hang-up, or a TLS
// failure (which needs a handshake to have started).
const REACHED_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ECONNABORTED']);
const REACHED_CODE_PATTERN =
  /^(?:ERR_SSL_|ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|HPE_)/u;
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'ENODATA']);

/**
 * What one attempt proves. Pure. A GCP firewall deny drops packets silently, so a denied attempt can
 * only time out before its TCP connect.
 *
 *   silent   it timed out before any TCP connect: a firewall drop, the only outcome that passes;
 *   reached  a packet came back: a connect, an HTTP status, a refusal, a reset, a hang-up, a TLS
 *            error, or a timeout after the connect;
 *   dns      the name did not resolve, so nothing was sent;
 *   unclear  anything else (a local error, an unknown code), never a pass.
 *
 * @param {Attempt} attempt
 * @returns {'silent' | 'reached' | 'dns' | 'unclear'}
 */
export function classifyAttempt(attempt) {
  if (typeof attempt.status === 'number' || attempt.connected === true) return 'reached';
  const code = attempt.code ?? '';
  if (
    REACHED_CODES.has(code) ||
    REACHED_CODE_PATTERN.test(code) ||
    /socket hang up/iu.test(attempt.error ?? '')
  ) {
    return 'reached';
  }
  if (DNS_CODES.has(code)) return 'dns';
  if (attempt.timedOut === true) return 'silent';
  return 'unclear';
}

/** @param {Attempt} attempt */
export function describeAttempt(attempt) {
  if (typeof attempt.status === 'number') return `answered ${String(attempt.status)}`;
  const why =
    [attempt.code, attempt.error].filter((part) => part !== undefined && part !== '').join(' ') ||
    'unknown';
  if (attempt.connected === true) return `connected, then ${why}`;
  if (attempt.timedOut === true) return 'timed out before connecting';
  return `got no answer (${why})`;
}

/**
 * Turn the raw probe measurements into the lane's results. Pure.
 *
 * Every attempt at a denied destination (the public host, the private range, the Google VIPs and the
 * gateway's run.app URL) must time out before the TCP connect: the sandbox firewall drops those
 * packets silently. Anything that proves a packet came back is a `SECURITY:` fail; the VIPs matter
 * because Google's front end serves every *.run.app service and bucket of every project.
 *
 * @param {{
 *   gateway: Attempt;
 *   gatewayRunApp: Attempt;
 *   gatewayRunAppViaVip?: Attempt;
 *   appRunApp?: Attempt;
 *   appRunAppViaVip?: Attempt;
 *   internet: Record<string, Attempt>;
 *   private: Record<string, Attempt>;
 *   privateControl: boolean;
 *   googleVip: Record<string, Attempt>;
 * }} raw
 */
export function evaluateProbes(raw) {
  // Cloud Run answers 404 when its ingress refuses a request, so only the gateway's own 200 proves it was reached.
  const gatewayOk = raw.gateway.status === 200;
  const gateway = result(
    'The gateway answers from a none sandbox through its internal load balancer',
    gatewayOk ? 'pass' : 'fail',
    typeof raw.gateway.status === 'number'
      ? `GET /health answered ${String(raw.gateway.status)} (want 200)`
      : `no answer: ${raw.gateway.error ?? 'unknown'}`,
  );
  const blind = (title) => blindResult(title, GATEWAY_CONTROL_FAILED);

  const internetTitle = 'A none sandbox cannot reach a public host';
  const privateTitle = 'A none sandbox cannot reach the private ranges';
  const vipTitle =
    'A none sandbox gets no answer from the Google VIPs (run.app services and buckets of any project)';
  const runAppTitle = "A none sandbox gets no answer from the gateway's run.app URL";
  const appTitle = 'A none sandbox cannot reach an app service';
  const hasApp = raw.appRunApp !== undefined;
  if (!gatewayOk) {
    return {
      'gateway-reachable': gateway,
      'egress-internet': blind(internetTitle),
      'egress-private-range': blind(privateTitle),
      'egress-google-vip': blind(vipTitle),
      'egress-gateway-run-app': blind(runAppTitle),
      ...(hasApp ? { 'egress-app-run-app': blind(appTitle) } : {}),
    };
  }

  const privateRange = raw.privateControl
    ? evaluateSilent(privateTitle, 'the private range', raw.private)
    : result(
        privateTitle,
        'inconclusive',
        'the positive control failed: the private address is not reachable from the services subnet either',
      );

  return {
    'gateway-reachable': gateway,
    'egress-internet': evaluateSilent(internetTitle, 'a public host', raw.internet),
    'egress-private-range': privateRange,
    'egress-google-vip': evaluateSilent(vipTitle, 'the Google VIP', raw.googleVip),
    'egress-gateway-run-app': evaluateRunApp(
      runAppTitle,
      raw.gatewayRunApp,
      raw.gatewayRunAppViaVip,
    ),
    ...(hasApp
      ? { 'egress-app-run-app': evaluateRunApp(appTitle, raw.appRunApp, raw.appRunAppViaVip) }
      : {}),
  };
}

/**
 * Attempts at one denied destination: a pass only when every one timed out before its connect.
 *
 * @param {string} title @param {string} target @param {Record<string, Attempt>} attempts
 */
export function evaluateSilent(title, target, attempts) {
  const all = Object.entries(attempts).map(([name, attempt]) => ({
    name,
    attempt,
    kind: classifyAttempt(attempt),
  }));
  const seen = all.map(({ name, attempt }) => `${name} ${describeAttempt(attempt)}`).join(', ');
  if (all.length === 0) return result(title, 'inconclusive', `no probe of ${target} ran`);
  if (all.some(({ kind }) => kind === 'reached')) {
    return result(title, 'fail', `${SECURITY_PREFIX} a none sandbox reached ${target} (${seen})`);
  }
  if (all.some(({ kind }) => kind !== 'silent')) {
    return result(
      title,
      'inconclusive',
      `only a timeout before the connect proves the deny (${seen})`,
    );
  }
  return result(title, 'pass', seen);
}

/**
 * The gateway's run.app URL by name. A DNS failure sends nothing, so by itself it proves nothing; it
 * passes only when the IP-literal request for the same host to the VIP timed out before connecting.
 *
 * @param {string} title @param {Attempt} byName @param {Attempt | undefined} viaVip
 */
function evaluateRunApp(title, byName, viaVip) {
  const kind = classifyAttempt(byName);
  if (kind === 'reached') {
    return result(
      title,
      'fail',
      `${SECURITY_PREFIX} a none sandbox reached a run.app URL through the Google VIP (${describeAttempt(byName)})`,
    );
  }
  if (kind === 'silent') return result(title, 'pass', describeAttempt(byName));
  if (kind === 'dns' && viaVip !== undefined && classifyAttempt(viaVip) === 'silent') {
    return result(
      title,
      'pass',
      `the name did not resolve (${describeAttempt(byName)}); the IP-literal request to the VIP ${describeAttempt(viaVip)}`,
    );
  }
  return result(
    title,
    'inconclusive',
    `only a timeout before the connect proves the deny (${describeAttempt(byName)})`,
  );
}

/**
 * The token result. Pure. The Cloud Run API must refuse the sandbox identity's token with 403, and
 * testIamPermissions on the project must answer 200 and grant none of SENSITIVE_PERMISSIONS. Any
 * other answer from either call is inconclusive, which fails the lane.
 *
 * @param {{
 *   tokenStatus?: number;
 *   apiStatus?: number;
 *   error?: string;
 *   iam?: { status?: number; granted?: unknown; error?: string };
 * }} metadata
 */
export function evaluateToken(metadata) {
  const { tokenStatus, apiStatus, iam } = metadata;
  const failures = [];
  const unclear = [];

  if (typeof apiStatus === 'number' && apiStatus >= 200 && apiStatus < 300) {
    failures.push(`the metadata token was accepted by the Cloud Run API (${String(apiStatus)})`);
  } else if (apiStatus !== 403) {
    unclear.push(
      `token endpoint ${String(tokenStatus ?? 'no answer')}, Cloud Run API ${String(apiStatus ?? metadata.error ?? 'no answer')}`,
    );
  }

  const granted = iam?.granted;
  if (iam?.status !== 200) {
    unclear.push(`testIamPermissions ${String(iam?.status ?? iam?.error ?? 'did not run')}`);
  } else if (
    !Array.isArray(granted) ||
    !granted.every((permission) => typeof permission === 'string')
  ) {
    unclear.push('testIamPermissions answered 200 without a permission list');
  } else if (granted.length > 0) {
    failures.push(`testIamPermissions granted the metadata token ${granted.join(', ')}`);
  }

  if (failures.length > 0) return result(METADATA_TITLE, 'fail', failures.join('; '));
  if (unclear.length > 0) return result(METADATA_TITLE, 'inconclusive', unclear.join('; '));
  return result(
    METADATA_TITLE,
    'pass',
    `the Cloud Run API answered 403, and testIamPermissions granted none of ${String(SENSITIVE_PERMISSIONS.length)} sensitive permissions`,
  );
}

/**
 * The positive control for app reachability: an app answers /api/health with 200 inside the VPC.
 * Pure.
 *
 * @param {Attempt} attempt
 */
export function evaluateAppHealth(attempt) {
  const ok = attempt.status === 200;
  return result(
    'An app answers /api/health inside the VPC',
    ok ? 'pass' : 'fail',
    typeof attempt.status === 'number'
      ? `GET /api/health answered ${String(attempt.status)} (want 200)`
      : `no answer: ${attempt.error ?? 'unknown'}`,
  );
}
