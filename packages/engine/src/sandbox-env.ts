/**
 * The sandbox environment contract, generalised past one engine (ENG-04, #303).
 *
 * Spec A.11: *"Provider master credentials never enter a sandbox."* Until this unit that
 * sentence was enforced in two Claude-shaped places — `packages/runtime/src/env.ts` refuses to
 * *emit* `ANTHROPIC_API_KEY`, and the Claude compile step refuses to compile a run whose
 * environment carries it. Both are checks about one provider's spelling of one credential, and a
 * second engine brings `OPENAI_API_KEY`, `GEMINI_API_KEY` and whatever the third one calls its
 * own.
 *
 * So the rule is restated as a property of the environment rather than a list of names:
 *
 *   1. **`ANTHROPIC_API_KEY` is absent.** Kept by name because A.11 names it, and because it is
 *      the one variable the Claude Agent SDK's bundled CLI will pick up *in preference to* the
 *      gateway token if it is ever present — so its absence is not a tidiness rule, it is what
 *      makes `ANTHROPIC_AUTH_TOKEN` the credential the run actually uses.
 *   2. **Every `*_API_KEY` and every `*_AUTH_TOKEN` in the environment holds the run token.**
 *      Not "holds something that looks short-lived", and not "is on an allow-list of names": the
 *      value is compared against the one token this run was issued. A variable carrying anything
 *      else is a provider credential by definition — it is a secret in a credential-shaped
 *      variable that the gateway did not mint — whatever it is called.
 *
 * Rule 2 is the half a name list cannot express, and it is the half that generalises: an engine
 * this repository has never heard of, reading a variable this module has never heard of, is
 * covered as long as the variable is spelled like a credential. What it does **not** cover is
 * stated rather than implied: a provider credential smuggled through a variable named neither
 * `*_API_KEY` nor `*_AUTH_TOKEN` is outside this check, which is why `RunEnvironment`'s reserved
 * names and the gateway's own token issuance remain the primary defences and this is the gate
 * that catches a regression in either.
 *
 * Rule 2 also covers an **agent secret** stored under a credential-shaped name (`OPENAI_API_KEY`,
 * `STRIPE_API_KEY`), which is a valid secret name. `packages/runtime`'s `buildRuntimeEnvironment`
 * — the injector that emits agent secrets — refuses such a name itself, so the operator reads a
 * sentence about the secret rather than this module's sentence about model connections
 * (ADR-0070, Consequences).
 *
 * `formal/AgentWorkspace/Behaviour/SandboxEnv.lean` models both rules, and
 * `formal/AgentWorkspace/Theorems/Adversarial/EngineSandboxEnv.lean` proves that every request
 * every engine compiles satisfies them.
 */

/** A.11's own forbidden entry, by name. See rule 1 in this module's header for why by name. */
export const PROVIDER_MASTER_CREDENTIAL_ENV = 'ANTHROPIC_API_KEY';

/**
 * The two suffixes that make a variable credential-shaped.
 *
 * Compared case-insensitively, because environment names are case-insensitive on Windows and a
 * gate that read `anthropic_api_key` as a different variable from `ANTHROPIC_API_KEY` would be a
 * gate with a spelling past it. (`RunEnvironment` in `packages/core` refuses the collision at
 * the schema; this module does not rely on that having happened.)
 */
export const CREDENTIAL_ENV_SUFFIXES = ['_API_KEY', '_AUTH_TOKEN'] as const;

export type SandboxEnvVerdict =
  | { readonly ok: true; readonly checked: number }
  | { readonly ok: false; readonly variable: string; readonly reason: string };

/** Is this variable name one the rules above treat as carrying a credential? */
export function isCredentialEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return CREDENTIAL_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

/**
 * Decide whether one compiled sandbox environment may be handed to an engine.
 *
 * `ok: true` carries `checked` — how many credential-shaped variables were examined — for the
 * ADR-0015 reason the whole repository applies to gates: a verdict that reported success without
 * saying what it looked at would pass identically when the environment was empty because
 * something upstream had dropped it.
 *
 * The comparison against `runToken` is by value and not by prefix or length. A token that merely
 * *resembles* the issued one is a different token, and a run whose credential is a different
 * token is a run reaching the gateway as somebody else.
 */
export function sandboxEnvironmentVerdict(
  env: Readonly<Record<string, string>>,
  runToken: string,
): SandboxEnvVerdict {
  let checked = 0;
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === PROVIDER_MASTER_CREDENTIAL_ENV) {
      return {
        ok: false,
        variable: name,
        reason: `${name} must never enter a sandbox (spec A.11). The gateway's short-lived, run-scoped ANTHROPIC_AUTH_TOKEN is the sanctioned path (spec §26); remove ${name} from this run's environment.`,
      };
    }
    if (!isCredentialEnvName(name)) continue;
    checked += 1;
    if (value !== runToken) {
      return {
        ok: false,
        variable: name,
        reason: `${name} is spelled like a credential and does not hold this run's gateway token, so it is a provider credential entering the sandbox (spec A.11). Route the model connection through the gateway instead of handing the engine a provider key.`,
      };
    }
  }
  return { ok: true, checked };
}
