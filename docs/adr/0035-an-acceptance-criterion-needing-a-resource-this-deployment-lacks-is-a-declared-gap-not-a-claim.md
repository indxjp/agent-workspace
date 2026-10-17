# ADR-0035 — An acceptance criterion that needs a resource this deployment does not have is closed as a declared gap, never as a claim

Status: accepted
Date: 2026-09-05
Decided by: orchestrator, on being instructed to run every remaining wave to close
Scope: Waves 3–9; every acceptance criterion in the development plan §6.5–§6.11

## Context

The instruction for this session is to finish every remaining wave. Read literally against the
plan's own acceptance criteria, several of them cannot be finished here, and the reason is not
difficulty. It is that the criterion names a resource this deployment does not contain:

| Criterion | Plan | What it needs |
| --- | --- | --- |
| "Real create → run → destroy against the real service, transcript in the PR" | W6-RT-03 | a funded account with the chosen managed sandbox service |
| "`helm install` on two distributions" | W6-INF-02 | two live Kubernetes distributions |
| "A.12 suite green on kind or k3s" | W6-RT-01 | a local cluster and a container runtime with the right privileges |
| "Publish both images to the chosen registry … deploy by digest" | W6-INF-07 | a registry the Owner controls; the card is itself marked PL-3 |
| "All ten scenarios green against the real API" | W4-GW-03 | a provider credential — which [ADR-0021](0021-phase-0-credential-step-belongs-to-wave-4.md) forbids placing where a run could read it |
| "Completed without reading the source" | W8-OPS-04 | a non-engineer human, timed |
| "Each command block was executed once by a human or a cloud-admin agent" | W7-DOC-06 | the same |
| "residual risks … accepted in writing by the Owner" | W8-SEC-03 | the Owner, who is a person |

Four of those cards are already marked PL-3 or PL-2-pending-account in the plan, so the plan
anticipated this. What the plan does not say is what a wave is allowed to *report* when it reaches
one, and that silence is where the damage would happen.

There is a strong pull toward the wrong answer here. The instruction says close every wave; a wave
does not close until its manifest exists; a manifest whose exit criterion is marked `Met: no` looks
like a failure to comply. Every one of those pressures pushes toward writing `Met: yes` and quietly
choosing a weaker demonstration — a mocked cluster, a stubbed provider, an agent playing the part of
the non-engineer — and calling it the criterion.

That failure already has a name in this repository. §9.3's honesty gate 1 is precisely "a manifest
claiming an unmet exit criterion was met". The waves README states, in the template it tells
every wave to copy verbatim, that `Met: no` **is an acceptable answer and must state why**. And the
programme's single largest carried item — spec §46's "receive streamed result" — exists as an open
item today only because [ADR-0021](0021-phase-0-credential-step-belongs-to-wave-4.md) refused to
fake it when an orchestrator instruction asked for exactly that.

## Decision

**A criterion that requires a resource this deployment does not have is closed as a declared gap.
It is never closed by substituting a weaker demonstration and reporting the criterion as met.**

Concretely, for each such criterion the owning task must produce all four of:

1. **The command that was actually attempted, and its actual output.** Not a description of why it
   would fail — the real invocation and the real error. `helm install` against no cluster produces a
   specific message; that message is the evidence.
2. **A named missing resource.** "A Kubernetes cluster reachable from this machine", "an Azure
   subscription with the Container Apps dynamic-sessions preview enabled", "a person who has not
   read this repository". If the sentence cannot name what is missing, the criterion was probably
   achievable and the task stopped too early.
3. **Everything that *can* be verified without the resource, actually verified.** A chart with no
   cluster still passes `helm lint` and `helm template`; a provider with no key still runs its
   compatibility suite against a stub and still publishes an honest §41 matrix row; a driver with no
   cloud still compiles, still reports its capabilities, and still fails the A.12 scenarios it
   cannot satisfy *as failures*. The gap is the last mile, and only the last mile is deferred.
4. **The gap carried forward explicitly** — in the PR's `## Declared gaps`, in the wave manifest's
   "Carried into the next wave", and in the wave handoff notes. Anything not listed there does not
   exist in the next wave (the waves README).

A wave closes with unmet criteria recorded as unmet. Its manifest says `Met: no — <why>`, and the
wave is closed in the sense that matters: everything achievable here was built, verified and landed,
and what remains is stated precisely enough that whoever has the account can finish it in an
afternoon.

## Consequences

**What this costs.** The programme will end with a release that is honestly incomplete rather than a
release that claims completeness. Waves 6 and 8 in particular will close with several `Met: no`
rows. A reader skimming the manifests will see failures that a dishonest programme would not show.

**What it buys.** Every `✓` that does appear is backed by something that ran. That is not a
stylistic preference: W8-QA-02's own acceptance criterion is "a weakened test cannot produce a `✓`",
and §41 and A.10 both exist to publish capability matrices an operator will make deployment
decisions from. A fabricated row in either is a lie told to someone choosing an isolation boundary.

**The stopping condition this gives us.** Without this rule there is no principled point at which a
wave is finished, because there is always one more substitution available. With it the rule is
mechanical: build everything the resource-free part of the criterion covers, attempt the rest, paste
the failure, name the resource, carry it forward.

## Alternatives rejected

**Mark the blocked waves "not started" and stop.** This throws away the large majority of each wave
that is perfectly buildable here — a Kubernetes driver is mostly code, and its code is testable.

**Substitute a weaker demonstration and note the substitution in small print.** This is the honesty
gate 1 failure with a disclaimer attached. The Wave 1a manifest records what happens when a
PR's Acceptance section lists gates that passed while the thing being claimed did not: the verifier
catches it, and the round is wasted.

**Escalate each one to the Owner and wait.** §3.5's escalation protocol is the right instrument for
a rule *conflict*. This is not a conflict; it is a missing resource, and the standing instruction for
this session is explicitly not to stop and ask. The gap record *is* the escalation, in a durable
form the Owner can act on whenever they choose.

## Related

- [ADR-0021](0021-phase-0-credential-step-belongs-to-wave-4.md) — the precedent: an orchestrator
  instruction to fake a capability, refused with citations, and the refusal upheld.
- [ADR-0016](0016-measured-numbers-do-not-live-in-prose.md) — the same principle applied to numbers:
  derive it or omit it, never assert it.
- [ADR-0031](0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md) — state the
  limit; never imply completeness.
