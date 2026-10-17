/** Pure parts of the provider live lane, kept apart from the lane so `unit.test.mjs` can pin them. */

/** Replace every non-empty secret in `text`. Run over anything that can reach a log or a results file. */
export function redact(text, secrets) {
  return secrets
    .filter((secret) => secret !== '')
    .reduce((out, secret) => out.replaceAll(secret, '[redacted]'), text);
}

/** Every lane records every check, so a check a provider cannot run reads `n/a`, never `missing`. */
export const CHECKS = {
  'non-root': 'Sandbox runs as a non-root user',
  'gateway-reachable': 'Gateway host reachable (under none, or open where none is unsupported)',
  'none-blocks-public': 'none: a non-gateway public host is unreachable',
  'none-blocks-cloud-metadata': 'none: no cloud metadata at 169.254.169.254 (blocked, or proven per-VM MMDS), 169.254.169.253 blocked',
  'none-blocks-private': 'none: RFC 1918 and 100.64/10 are unreachable',
  'open-reaches-public': 'open: a public host is reachable',
  'open-blocks-cloud-metadata': 'open: no cloud metadata at 169.254.169.254 (blocked, or proven per-VM MMDS), 169.254.169.253 blocked',
  'open-blocks-private': 'open: RFC 1918 and 100.64/10 are unreachable',
  'metadata-is-per-vm-mmds': 'info: 169.254.169.254:80 answers and is proven per-VM Firecracker MMDS (n/a when blocked)',
  'no-ipv6-egress': 'none and open: link-local, ULA and loopback IPv6 are unreachable; under none, IPv6 public too',
  loopback: 'Provider host loopback is unreachable',
  deadline: 'Deadline enforced by the provider',
  'restricted-refused': 'restricted is refused with network_policy_unsupported',
  'open-refused': 'open is refused with network_policy_unsupported where unsupported',
  'none-refused': 'none is refused with network_policy_unsupported before any sandbox or bridge call where unsupported',
  'all-policies-refused': 'none, open and restricted are each refused before any sandbox or bridge call where no policy is declared',
  'bridge-auth': 'Bridge refuses a call missing either credential',
};

/** A probe artefact that could not be built or pushed fails every row; `skipped` is only for missing credentials. */
export function failedRows(reason) {
  return Object.fromEntries(
    Object.entries(CHECKS).map(([id, title]) => [id, { title, outcome: 'fail', detail: `probe artefact: ${reason}` }]),
  );
}

export const PRIVATE_TARGETS = ['rfc1918-10', 'rfc1918-172', 'rfc1918-192', 'cgnat'];

export class Inconclusive extends Error {}

/**
 * "X is unreachable" is only evidence if the same sandbox, in the same probe, reached `control`
 * (the gateway). A timeout or a refusal counts as blocked only then; a control that did not answer
 * makes the row `inconclusive`, never a pass. A target that answered, or that the probe did not
 * report at all, is `fail`.
 */
export function blockedVerdict(attempts, targets, control) {
  if (attempts[control]?.answered !== true) {
    throw new Inconclusive(`positive control "${control}" did not answer, so nothing is proven`);
  }
  const reached = targets.filter((target) => attempts[target]?.answered !== false);
  if (reached.length > 0) {
    throw new Error(`reachable or unreported: ${reached.map((target) => `${target} (${attempts[target]?.outcome ?? 'unreported'})`).join(', ')}`);
  }
}

const describe = (attempt) => {
  if (attempt?.answered !== true) return attempt === undefined ? 'unreported' : String(attempt.outcome);
  const exchange = attempt.exchange;
  if (exchange === undefined) return 'connected, no exchange evidence';
  if (exchange.bytes === 0 && exchange.end === 'timeout') return 'connected, no reply before timeout';
  return `connected, ${exchange.bytes} bytes${exchange.status === null ? '' : `, HTTP ${exchange.status}`}`;
};

/**
 * The private ranges are unreachable when every target is blocked (`blockedVerdict`), or when a
 * provider egress proxy accepts the TCP connect for the addresses not blocked and nothing answers behind it:
 * the unroutable sentinel `test-net` (192.0.2.1) connected too, and neither it, any private target nor
 * the `-fronted` variant of either (same address, the gateway's Host header) returned a byte before the
 * connection closed or reset. The `-fronted` variant of a blocked target must be blocked or silent too.
 * A connect without that evidence, a stall until timeout, a missing `-fronted` report, or any byte is
 * `fail`. Returns a detail.
 */
export function privateVerdict(attempts, control) {
  if (attempts[control]?.answered !== true) {
    throw new Inconclusive(`positive control "${control}" did not answer, so nothing is proven`);
  }
  const reached = PRIVATE_TARGETS.filter((target) => attempts[target]?.answered !== false);
  if (reached.length === 0) return 'refused or timed out';
  const sentinel = attempts['test-net'];
  const silent = (attempt) =>
    attempt?.answered === true && attempt.exchange?.bytes === 0 && ['close', 'reset'].includes(attempt.exchange.end);
  const connects = [...reached, 'test-net'].flatMap((target) => [target, `${target}-fronted`]);
  const blocked = PRIVATE_TARGETS.filter((target) => !reached.includes(target)).map((target) => `${target}-fronted`);
  const failing = [
    ...connects.filter((name) => !silent(attempts[name])),
    ...blocked.filter((name) => attempts[name]?.answered !== false && !silent(attempts[name])),
  ];
  if (failing.length === 0) {
    return `TCP accepted by the egress proxy for ${reached.join(', ')} and unroutable 192.0.2.1, also with the gateway's Host; none returned a byte${reached.length < PRIVATE_TARGETS.length ? '; the rest refused or timed out' : ''}`;
  }
  throw new Error(`reachable or unproven: ${failing.map((name) => `${name} (${describe(attempts[name])})`).join(', ')}`);
}

/**
 * A sandbox that stopped answering `/ping` proves nothing alone: the network or the edge may be
 * down. Only the provider API answering `stopped` passes; `running` is `fail`; anything else (a
 * failed lookup, an unknown state, no lookup) is `inconclusive`.
 */
export function deadlineVerdict(stillAnswers, state) {
  if (stillAnswers) throw new Error('the sandbox still answers /ping after its deadline');
  if (state === 'running') throw new Error('the provider reports the sandbox running after its deadline');
  if (state !== 'stopped') {
    throw new Inconclusive(`the provider gave no definite answer (${state ?? 'no lookup'}), so nothing is proven`);
  }
}

/** The only top-level keys Firecracker MMDS may serve on E2B (ADR-0120 LC4 amendment). */
export const MMDS_KEYS = ['accessTokenHash', 'address', 'envID', 'instanceID'];

const ok = (status) => typeof status === 'number' && status >= 200 && status < 300;

/**
 * `169.254.169.254:80` is either blocked (pass, as before) or, when it connects, proven to be
 * Firecracker's per-VM MMDS and nothing else: an unauthenticated GET answers 401, the token flow
 * returns a non-empty subset of `MMDS_KEYS`, no GCP, IMDSv2 or IMDSv1 cloud-metadata read succeeds,
 * and `169.254.169.253:80` stays blocked. A connect without that proof is `fail`. Messages carry
 * statuses and key names only. Returns `{ mmds, keys }`.
 */
export function cloudMetadataVerdict(attempts, control) {
  if (attempts[control]?.answered !== true) {
    throw new Inconclusive(`positive control "${control}" did not answer, so nothing is proven`);
  }
  const metadata = attempts.metadata;
  if (metadata?.answered === false) return { mmds: false, keys: [] };
  if (metadata?.answered !== true) throw new Error('metadata: unreported');
  const reasons = [];
  if (attempts['link-local-2']?.answered !== false) reasons.push('169.254.169.253 is reachable or unreported');
  const evidence = metadata.evidence;
  if (evidence === undefined || evidence === null) {
    reasons.push('169.254.169.254:80 connects without proof of what answers');
  } else {
    if (evidence.unauthenticatedStatus !== 401) {
      reasons.push(`unauthenticated GET answered ${String(evidence.unauthenticatedStatus)}, not MMDS's 401`);
    }
    if (!ok(evidence.tokenStatus)) reasons.push(`MMDS token PUT answered ${String(evidence.tokenStatus)}`);
    const keys = evidence.keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      reasons.push('the token flow returned no key set');
    } else {
      const extra = keys.filter((key) => !MMDS_KEYS.includes(key));
      if (extra.length > 0) reasons.push(`unexpected keys: ${extra.join(', ')}`);
    }
    if (evidence.flat !== true) reasons.push('the MMDS tree has a non-string value');
    if (ok(evidence.gcp?.status) || evidence.gcp?.flavor === true) reasons.push('GCP metadata answered');
    if (ok(evidence.imdsv2?.iamStatus)) reasons.push('AWS IMDSv2 iam/ answered');
    if (ok(evidence.imdsv1?.iamStatus)) reasons.push('AWS IMDSv1 iam/ answered');
  }
  if (reasons.length > 0) throw new Error(reasons.join('; '));
  return { mmds: true, keys: evidence.keys };
}

/**
 * A policy the provider declares unsupported reads `n/a` only on proof (ADR-0131): `create` was
 * refused with `RuntimeRefusalError` `network_policy_unsupported`, no sandbox came back and the
 * bridge was not called. A created sandbox, another error (a timeout included) or a bridge call is
 * `fail`. `attempt` is `{ created, error?, bridgeCalls }`. Returns a detail.
 */
export function refusalVerdict(attempt, policy, RuntimeRefusalError) {
  if (attempt.created) throw new Error(`${policy} is declared unsupported, yet a sandbox was created`);
  const { error } = attempt;
  if (!(error instanceof RuntimeRefusalError) || error.code !== 'network_policy_unsupported') {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${policy} was not refused with RuntimeRefusalError network_policy_unsupported: ${message}`);
  }
  if (attempt.bridgeCalls !== 0) {
    throw new Error(`${policy} was refused only after ${String(attempt.bridgeCalls)} bridge call(s)`);
  }
  return `${policy} refused with network_policy_unsupported; no sandbox created, no bridge call`;
}

/** Every policy a run spec can name; a provider declaring none of them must refuse each. */
export const RUN_POLICIES = ['none', 'open', 'restricted'];

/** The rows that need a created sandbox; `bridge-auth` is not one, its bridge half needs none. */
export const CREATE_ROWS = [
  'non-root',
  'gateway-reachable',
  'none-blocks-public',
  'none-blocks-cloud-metadata',
  'none-blocks-private',
  'open-reaches-public',
  'open-blocks-cloud-metadata',
  'open-blocks-private',
  'metadata-is-per-vm-mmds',
  'no-ipv6-egress',
  'deadline',
];

/**
 * A provider that declares no network policy can create no sandbox, so its create-based rows read
 * `n/a`, and `all-policies-refused` `pass`, only once the real `create` is proven refused for every
 * one of `RUN_POLICIES` (`refusalVerdict` each); any other outcome throws, so every such row fails.
 * `attempts` maps each policy to its `create` attempt. Returns `{ [row]: { outcome, detail } }`.
 */
export function noPolicyRows(attempts, RuntimeRefusalError) {
  const detail = RUN_POLICIES.map((policy) => refusalVerdict(attempts[policy], policy, RuntimeRefusalError)).join('; ');
  const notApplicable = { outcome: 'n/a', detail: 'no network policy is declared, so no sandbox can be created; all-policies-refused proves it' };
  return {
    ...Object.fromEntries(CREATE_ROWS.map((id) => [id, notApplicable])),
    'all-policies-refused': { outcome: 'pass', detail },
  };
}

const NO_ROUTE = ['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL'];
const IPV6_DENIED = ['ipv6-link-local', 'ipv6-ula', 'ipv6-loopback'];

/**
 * Link-local, ULA and loopback IPv6 are unreachable under `none` and `open`; the IPv6 public host
 * too under `none`. Reached or unreported is `fail`. Returns a detail: "no IPv6 route" when every
 * non-loopback target failed with a no-route code.
 */
export function ipv6Verdict(attempts, policy, control) {
  if (attempts[control]?.answered !== true) {
    throw new Inconclusive(`positive control "${control}" did not answer, so nothing is proven`);
  }
  const targets = [...IPV6_DENIED, 'ipv6-public'];
  const unreported = targets.filter((target) => typeof attempts[target]?.answered !== 'boolean');
  if (unreported.length > 0) throw new Error(`unreported: ${unreported.join(', ')}`);
  const denied = policy === 'none' ? targets : IPV6_DENIED;
  const reached = denied.filter((target) => attempts[target].answered);
  if (reached.length > 0) throw new Error(`${policy}: reachable: ${reached.join(', ')}`);
  const noRoute = targets.filter((target) => target !== 'ipv6-loopback').every((target) => NO_ROUTE.includes(attempts[target].outcome));
  return noRoute ? 'no IPv6 route' : 'IPv6 targets unreachable';
}
