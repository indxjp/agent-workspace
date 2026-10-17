/**
 * The checks every adapter's `compile` opens with (#951).
 *
 * Each helper answers one refusal an adapter used to spell for itself: the same sentence with the
 * engine id renamed. They return an {@link EngineRefusal} (or a value carrying `ok: true`) so a
 * caller keeps its own order of checks and stops at the first refusal. Typed structurally, so this
 * port needs neither zod nor `@types/node`.
 */
import type { EngineCapabilities } from '@indx-workspace/contracts/engines';

import { normaliseGrants, type NormalisedGrant } from './path-grant.js';
import type {
  EngineGatewayConnection,
  EngineRefusal,
  EngineRefusalCode,
  EngineRunRequest,
  EngineSessionSelector,
} from './port.js';
import {
  PROVISIONAL_PRICES_CHECKED_ON,
  provisionalPriceFor,
  type ProvisionalModelPrice,
} from './prices.js';
import { sandboxEnvironmentVerdict } from './sandbox-env.js';

export function refuse(code: EngineRefusalCode, reason: string): EngineRefusal {
  return { ok: false, code, reason };
}

/** zod's `safeParse`, structurally — so the port needs no zod. */
export type PolicyArmParser<T> = {
  safeParse(
    value: unknown,
  ):
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: { readonly message: string } };
};

/** `engine_policy_invalid`: "the <engine> policy arm must be an object carrying <carrying>; <message>". */
export function parsePolicyArm<T>(
  engine: string,
  parser: PolicyArmParser<T>,
  carrying: string,
  policy: unknown,
): { readonly ok: true; readonly policy: T } | EngineRefusal {
  const parsed = parser.safeParse(policy);
  if (!parsed.success) {
    return refuse(
      'engine_policy_invalid',
      `the ${engine} policy arm must be an object carrying ${carrying}; ${parsed.error.message}`,
    );
  }
  return { ok: true, policy: parsed.data };
}

/** `request.resources.files` normalised against the adapter's directory, or `engine_policy_invalid`. */
export function normaliseRequestGrants(
  request: EngineRunRequest,
  protectedConfigDirectory: string,
): { readonly ok: true; readonly grants: readonly NormalisedGrant[] } | EngineRefusal {
  const grants = normaliseGrants(
    request.resources.files.map((file) => ({
      kind: file.kind,
      path: file.path,
      access: file.access,
    })),
    protectedConfigDirectory,
  );
  if (!grants.ok) return refuse('engine_policy_invalid', grants.reason);
  return grants;
}

/**
 * The gateway connection and the protocol this engine speaks for it — or `engine_credential_refused`
 * (no gateway) / `engine_capability_unsupported` (a protocol the engine does not speak).
 */
export function requireGateway<const P extends string>(
  engine: string,
  request: EngineRunRequest,
  protocols: readonly P[],
):
  | { readonly ok: true; readonly gateway: EngineGatewayConnection; readonly protocol: P }
  | EngineRefusal {
  const gateway = request.gateway;
  if (gateway === null) {
    return refuse(
      'engine_credential_refused',
      `${engine} reaches its model only through the gateway connection on the request, and this request carries none.`,
    );
  }
  const protocol = protocols.find((candidate) => candidate === gateway.protocol);
  if (protocol === undefined) {
    return refuse(
      'engine_capability_unsupported',
      `${engine} speaks ${protocols.join(', ')} to the gateway; this run's connection is served over ${JSON.stringify(gateway.protocol)}.`,
    );
  }
  return { ok: true, gateway, protocol };
}

/** Spec A.11 over `request.env` and the run token: `null` or `engine_credential_refused`. */
export function sandboxRefusal(
  env: Readonly<Record<string, string>>,
  token: string,
): EngineRefusal | null {
  const sandbox = sandboxEnvironmentVerdict(env, token);
  return sandbox.ok ? null : refuse('engine_credential_refused', sandbox.reason);
}

/** `engine_capability_unsupported` for a fork on an engine whose capabilities say `fork: false`, else `null`. */
export function forkRefusal(
  engine: string,
  capabilities: EngineCapabilities,
  session: EngineSessionSelector,
): EngineRefusal | null {
  if (capabilities.fork || session.mode !== 'fork') return null;
  return refuse(
    'engine_capability_unsupported',
    `${engine} declares fork: false, so a session cannot be branched on this engine.`,
  );
}

/**
 * `engine_capability_unsupported` naming each subagent for an engine whose capabilities say
 * `subagents: false`, else `null` (ADR-0133 D14: refused by name, never dropped or emulated).
 */
export function subagentsRefusal(
  engine: string,
  capabilities: EngineCapabilities,
  subagents: readonly { readonly name: string }[] | undefined,
): EngineRefusal | null {
  if (capabilities.subagents || subagents === undefined || subagents.length === 0) return null;
  const names = subagents.map((subagent) => JSON.stringify(subagent.name)).join(', ');
  return refuse(
    'engine_capability_unsupported',
    `${engine} declares subagents: false (ADR-0133 D14), so the subagent(s) ${names} cannot be honoured. Remove them from the agent or choose an engine with subagents.`,
  );
}

/**
 * `engine_capability_unsupported` naming each subagent that runs on a model other than the one the
 * cap is priced with, else `null`: the provisional cap meters every step with the parent model's
 * rates (ADR-0074 D7), so a delegate on another model would be metered wrongly, not refused.
 */
export function subagentBudgetRefusal(
  engine: string,
  model: string,
  maxBudgetUsd: number | null,
  subagents: readonly { readonly name: string; readonly model: string | null }[] | undefined,
): EngineRefusal | null {
  if (maxBudgetUsd === null) return null;
  const other = (subagents ?? []).filter(
    (subagent) => subagent.model !== null && subagent.model !== model,
  );
  if (other.length === 0) return null;
  const names = other.map((subagent) => JSON.stringify(subagent.name)).join(', ');
  return refuse(
    'engine_capability_unsupported',
    `${engine} prices a maxBudget cap with the agent's model ${JSON.stringify(model)} alone (ADR-0074 D7), so the subagent(s) ${names} on another model cannot be metered. Run them on the agent's model or remove the cap.`,
  );
}

/** The longest function name the providers accept (`^[a-zA-Z0-9_-]{1,64}$`). */
export const PROVIDER_TOOL_NAME_MAX_LENGTH = 64;

/**
 * Each subagent with its delegation tool name — `prefix` plus its name, every character a provider
 * refuses replaced by `_` — in order; or `engine_capability_unsupported` naming the subagent whose
 * tool name is too long or the same as an earlier one's. Agent names are free-form, so two of them
 * can sanitise to one tool name, and a provider rejects a long one mid-run rather than at compile.
 */
export function subagentToolNames<Subagent extends { readonly name: string }>(
  engine: string,
  prefix: string,
  subagents: readonly Subagent[] | undefined,
):
  | { readonly ok: true; readonly named: readonly (Subagent & { readonly toolName: string })[] }
  | EngineRefusal {
  const named: (Subagent & { readonly toolName: string })[] = [];
  for (const subagent of subagents ?? []) {
    const name = `${prefix}${subagent.name.replace(/[^a-zA-Z0-9_-]/gu, '_')}`;
    if (name.length > PROVIDER_TOOL_NAME_MAX_LENGTH) {
      return refuse(
        'engine_capability_unsupported',
        `${engine} offers subagent ${JSON.stringify(subagent.name)} as the tool ${JSON.stringify(name)}, longer than the ${String(PROVIDER_TOOL_NAME_MAX_LENGTH)} characters a provider accepts. Shorten the subagent's name.`,
      );
    }
    if (named.some((other) => other.toolName === name)) {
      return refuse(
        'engine_capability_unsupported',
        `${engine} offers subagent ${JSON.stringify(subagent.name)} as the tool ${JSON.stringify(name)}, which another subagent's name already maps to. Rename one of them.`,
      );
    }
    named.push({ ...subagent, toolName: name });
  }
  return { ok: true, named };
}

/**
 * ADR-0074 D7 provisional cap: `null` (no cap), the budget, or `engine_capability_unsupported` for a
 * model the provisional price table cannot price.
 */
export function provisionalBudget(
  engine: string,
  model: string,
  maxBudgetUsd: number | null,
):
  | { readonly maxBudgetUsd: number; readonly model: string; readonly price: ProvisionalModelPrice }
  | null
  | EngineRefusal {
  if (maxBudgetUsd === null) return null;
  const price = provisionalPriceFor(model);
  if (price === null) {
    return refuse(
      'engine_capability_unsupported',
      `${engine} enforces maxBudget from a provisional price table (ADR-0074 D7, checked ${PROVISIONAL_PRICES_CHECKED_ON}) which has no row for ${JSON.stringify(model)}, so a ${String(maxBudgetUsd)} USD cap cannot be enforced. Choose a priced model or remove the cap.`,
    );
  }
  return { maxBudgetUsd, model, price };
}
