/**
 * The §15.2 network-policy mapping, stored as data so the UI renders what each driver actually
 * enforces (spec §15.2: *"Map it explicitly and report what was actually achieved"*).
 *
 * `network-policy.test.ts` is this task's own §15.2 spec-transcription gate: one test reads
 * §15.2's markdown table out of `docs/spec.md` and asserts this file's `specCellText` values equal
 * it, cell for cell — never the other way round (this file is checked against the spec, not the
 * spec against this file), so a driver added to §15.2 and not here fails there. A second test
 * asserts §15.2's *rule* directly, not any one row's cell: *"`none` must always mean 'the gateway
 * and nothing else', never 'no network at all'"* (`docs/spec.md:1045`).
 *
 * ## The `divergence` field, and why four rows carry one
 *
 * A cell's `specCellText` is transcribed verbatim, even where — as with `docker` — implementing it
 * literally would violate the rule ten lines below it. Where that happens, `divergence` records
 * what the driver actually does instead, why, and the spec passage that requires the departure.
 * `divergence` is `null` everywhere else: a driver whose `none` cell already denotes "reach the
 * gateway and nothing else" (a network-layer default-deny that can still admit one destination —
 * `sandbox-runtime`, `kubernetes`, `gke-agent-sandbox`, `aws-ecs`) needs no departure from its own
 * printed cell to satisfy the rule, so recording one would be inventing a defect that is not there.
 *
 * Four rows carry a non-empty `divergence` for `none`, and the four are not a hand-picked list:
 *
 *   1. **`aca-sessions`, `aws-agentcore`, `cloud-run-sandbox`** — named verbatim in §15.2's own
 *      remedy paragraph as drivers "whose egress control is a single all-or-nothing switch"
 *      (`docs/spec.md:1047`); `network-policy.test.ts` extracts this exact list from that
 *      sentence, so it is derived from the spec text, not retyped.
 *   2. **`docker`** — the specification defect the Wave 3 plan's "What this plan corrects"
 *      item 6 records: `--network none` is a real, measured all-or-nothing switch (the probe is
 *      quoted below, byte for byte), it is exactly the shape the remedy paragraph describes, and
 *      the paragraph omits it. This is a **declared, exact addition** to the derived set — never a
 *      silent one — asserted in `network-policy.test.ts` as `derivedFromSpec ∪ {'docker'}`, so a
 *      fifth driver could never join it without a test failing to name it first (ADR-0031).
 *
 * `docker`'s divergence is what W3-RT-03 implements (`packages/runtime/src/docker.ts`, 3b-1): the
 * driver launches on a dedicated `agent-egress` network reaching the gateway and nothing else,
 * never `--network none`. This file and that driver describe **one** behaviour, per this task's
 * own Accept line.
 */

import type { RuntimeDriver } from '@indx-workspace/contracts/runtimes';

export type NetworkPolicyId = 'none' | 'restricted' | 'open';

export const networkPolicyIds: readonly NetworkPolicyId[] = ['none', 'restricted', 'open'];

export type NetworkPolicyEnforcementPoint = 'platform' | 'network' | 'proxy';

export interface NetworkPolicyDivergence {
  /** What the driver actually does, in the platform's own words — never the spec's cell text. */
  readonly actual: string;
  /** Where enforcement actually happens, when it is not the platform's native mechanism. */
  readonly enforcementPoint: NetworkPolicyEnforcementPoint;
  /** `docs/spec.md:<line>` — the passage that requires the departure from the printed cell. */
  readonly specCitation: string;
  /** A probe transcript or other measured evidence, when one exists (ADR-0016). */
  readonly evidence?: string;
}

export interface NetworkPolicyCell {
  /** §15.2's own cell text for this driver × policy, verbatim, backticks and all. */
  readonly specCellText: string;
  readonly divergence: NetworkPolicyDivergence | null;
}

export interface DriverNetworkPolicyRow {
  /** §14.2's `RuntimeDriverId` spelling, exactly as §15.2's first column prints it. */
  readonly driver: RuntimeDriver;
  readonly cells: Readonly<Record<NetworkPolicyId, NetworkPolicyCell>>;
  /**
   * What `none` is recorded to mean for this driver. §15.2's rule (`docs/spec.md:1045`) is that
   * this is **always** the same sentence — never "no network at all" — so every row's value here
   * must equal {@link NONE_MEANING}; `network-policy.test.ts` asserts that directly, driving the
   * value out of the spec sentence rather than trusting this file's own copy of it.
   */
  readonly noneMeaning: string;
}

/**
 * §15.2, `docs/spec.md:1045`, the quoted phrase — read by `network-policy.test.ts` out of the spec
 * text itself and asserted equal to this constant, so the two cannot drift independently.
 */
export const NONE_MEANING = 'the gateway and nothing else';

function cell(
  specCellText: string,
  divergence: NetworkPolicyDivergence | null = null,
): NetworkPolicyCell {
  return { specCellText, divergence };
}

const CLOUD_ALL_OR_NOTHING_CITATION = 'docs/spec.md:1047';

/** The remedy §15.2 prints for the three drivers it names, applied identically to each. */
function cloudAllOrNothingDivergence(actual: string): NetworkPolicyDivergence {
  return {
    actual,
    enforcementPoint: 'proxy',
    specCitation: CLOUD_ALL_OR_NOTHING_CITATION,
    evidence:
      'docs/spec.md:1047 names this driver among those "whose egress control is a single ' +
      'all-or-nothing switch", and its own remedy: "implement `none` as egress enabled, ' +
      'restricted to the gateway by our proxy".',
  };
}

export const networkPolicyMapping: readonly DriverNetworkPolicyRow[] = [
  {
    driver: 'sandbox-runtime',
    noneMeaning: NONE_MEANING,
    cells: {
      none: cell('default deny'),
      restricted: cell('domain allowlist via the built-in proxy (no TLS inspection)'),
      open: cell('allow all'),
    },
  },
  {
    driver: 'docker',
    noneMeaning: NONE_MEANING,
    cells: {
      // §15.2's own cell — kept verbatim because it is the specification, per this file's header.
      none: cell('`--network none`', {
        actual: '--network agent-egress',
        enforcementPoint: 'network',
        specCitation: 'docs/spec.md:1045',
        evidence:
          'Measured on this host, docker server 29.7.2 (the Wave 3 plan, "What this plan ' +
          'corrects" item 6):\n' +
          '$ docker run --rm --network none alpine:3.20 sh -c \'ip addr show | grep -E "^[0-9]+:"; ' +
          "wget -q -T 3 -O- http://192.168.65.254:4000/'\n" +
          '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN qlen 1000\n' +
          "wget: can't connect to remote host (192.168.65.254): Network unreachable\n" +
          '$ echo $?\n' +
          '1\n' +
          'A `--network none` container has one interface, loopback, and reaches no address at ' +
          'all — the literal cell text is "no network at all", which §15.2\'s own rule ' +
          "(docs/spec.md:1045) forbids `none` from meaning. §15.2's remedy paragraph " +
          '(docs/spec.md:1047) describes exactly this shape for three other drivers and omits ' +
          'docker; that omission is the specification defect this row records.',
      }),
      restricted: cell('egress network plus an allowlisting proxy container'),
      open: cell('bridge network'),
    },
  },
  {
    driver: 'kubernetes',
    noneMeaning: NONE_MEANING,
    cells: {
      none: cell('default-deny `NetworkPolicy`'),
      restricted: cell('`NetworkPolicy` plus egress proxy'),
      open: cell('permissive policy'),
    },
  },
  {
    driver: 'gke-agent-sandbox',
    noneMeaning: NONE_MEANING,
    cells: {
      none: cell('default deny (built in)'),
      restricted: cell('`NetworkPolicy` on the sandbox pod'),
      open: cell('permissive policy'),
    },
  },
  {
    driver: 'aca-sessions',
    noneMeaning: NONE_MEANING,
    cells: {
      none: cell(
        '`sessionNetworkConfiguration.status: EgressDisabled`',
        cloudAllOrNothingDivergence(
          'sessionNetworkConfiguration.status: EgressEnabled, behind the gateway-only proxy',
        ),
      ),
      restricted: cell(
        '**not supported** — approximate with an egress-enabled pool behind a proxy',
      ),
      open: cell('`EgressEnabled`'),
    },
  },
  {
    driver: 'aws-agentcore',
    noneMeaning: NONE_MEANING,
    cells: {
      none: cell(
        'network mode `Sandbox`',
        cloudAllOrNothingDivergence(
          'network mode VPC, security groups restricted to the gateway by the proxy',
        ),
      ),
      restricted: cell('VPC mode plus security groups / egress proxy'),
      open: cell('network mode `Public`'),
    },
  },
  {
    driver: 'aws-ecs',
    noneMeaning: NONE_MEANING,
    cells: {
      none: cell('no NAT, no internet gateway'),
      restricted: cell('security groups, VPC endpoints, egress proxy'),
      open: cell('public subnet or NAT'),
    },
  },
  {
    driver: 'cloud-run-sandbox',
    noneMeaning: NONE_MEANING,
    cells: {
      none: cell(
        'default (no `--allow-egress`)',
        cloudAllOrNothingDivergence(
          '--allow-egress, with VPC egress restricted to the gateway by the proxy',
        ),
      ),
      restricted: cell('`--allow-egress` plus VPC egress and Cloud NAT rules'),
      open: cell('`--allow-egress`'),
    },
  },
];

/**
 * The drivers that can enforce `restricted`: `docker` and `kubernetes` route sandbox egress through
 * the per-session allowlist proxy (ADR-0117 decision 7, #784), but only when the deployment sets
 * `AGENT_WORKSPACE_EGRESS_PROXY_IMAGE`. Every other driver, the Cloud Run and ACA ones included,
 * still refuses it. The same set decides whether the tool sandbox can enforce a code tool's
 * `allowedDomains` (#1018): `external` stays out until the E7 live lane proves the always-denied
 * ranges hold.
 */
export const RESTRICTED_PROXY_DRIVERS: ReadonlySet<string> = new Set<string>([
  'docker',
  'kubernetes',
] as const satisfies readonly RuntimeDriver[]);

/** Why `driver` cannot enforce `restricted` in this deployment, or `null` when it can. */
export function restrictedUnenforceableReason(
  driver: string,
  egressProxyConfigured: boolean,
): string | null {
  if (!RESTRICTED_PROXY_DRIVERS.has(driver)) return 'cannot enforce restricted yet';
  return egressProxyConfigured
    ? null
    : 'cannot enforce restricted without an egress proxy (AGENT_WORKSPACE_EGRESS_PROXY_IMAGE)';
}

/** One profile's network-policy cell, looked up by driver, for the UI to render. */
export function networkPolicyCellFor(
  driver: string,
  policy: NetworkPolicyId,
): NetworkPolicyCell | null {
  const row = networkPolicyMapping.find((entry) => entry.driver === driver);
  return row === undefined ? null : row.cells[policy];
}
