# ADR-0028 — ADR-0027 is applied by enumerating every tracked-listing narrowing in the file, not at the site the finding named; and it stops being prose

Status: accepted
Date: 2026-09-04
Decided by: orchestrator, after round 2 found six further instances in the four branches that had just repaired the first four
Scope: every gate in this repository; supersedes nothing, tightens [ADR-0027](0027-a-partition-that-lists-its-members-has-not-been-partitioned.md)

## Context

[ADR-0027](0027-a-partition-that-lists-its-members-has-not-been-partitioned.md) was written after
verification round 1 found the same defect in three gates by three authors: a set derived from the
tracked tree and then narrowed by a `.filter()`, so anything the regex did not match was silently
dropped and the gate stayed green.

Round 2 repaired all four named sites. Fresh verifiers then found **six more instances, in the same
files, by the same authors, in the same round** — every one of them at a *different* line from the
one the finding named:

| Where | The narrowing |
| --- | --- |
| `tests/no-sdk-import.test.ts` | `collectAliases()` filters the tracked listing by `/^tsconfig(\..+)?\.json$/` with a silent `continue` |
| `tests/screen-inventory.test.ts` | `planSources()` filters `git ls-files -- docs` by a wave-plan regex |
| `tenancy.test.ts` | `schemaModuleFiles()` uses `readdirSync` + `.filter()` — a *working-tree* listing, not `git ls-files` |
| `tenancy.test.ts` | `CREATE_TABLE` / `DROP_TABLE` match only double-quoted identifiers and filter the migration text |
| `scope-forgery.test.ts` | the repository-provider set is a regex over module text with no `else`, so a provider written in arrow form is unchecked |
| `database-reachability.test.ts` | the pathspec is `*.ts *.tsx *.mts *.cts`, dropping twenty tracked `.js`/`.mjs` files including an executed acceptance harness |

Three of the four branches additionally shipped an ADR or header asserting, in the present tense,
that *"every such rule is a classifier that ends in rejection"* — in the same file as a
counter-example. That is [ADR-0016](0016-measured-numbers-do-not-live-in-prose.md)'s failure applied
to ADR-0027's rule: a claim about the code, written without running anything over the code.

The repairs were not careless. They were **local**: each fixed the line it was shown. Nobody was
asked to go looking, and the rule as written does not say to.

## Decision

1. **A finding of this class is a finding about the file, not the line.** A task repairing one
   instance must enumerate **every** place in the files it owns where a listing — `git ls-files`,
   `readdirSync`, a directory walk, or a scan of module text — is narrowed, and for each one either
   convert it to a classifier that ends in rejection or declare it, by path and line, as a gap with
   its reason. "The finding named one site" is not a defence.
2. **No prose may assert this property of a file.** A sentence saying a file's rules are all
   classifiers is a measured claim about code and falls under ADR-0016. Say what the rule at hand
   does; do not quantify over the file.
3. **The rule becomes mechanical, as a task of this wave: `W2-INT-02`.** Prose has now failed twice
   in two rounds, and ADR-0016's own lesson is that a check nobody runs is a comment with extra
   steps. W2-INT-02 lands, at the top of the 2a stack once the repairs are in:
   * a shared helper — one function that takes a listing and a classifier, returns the groups, and
     **throws naming any element that fell into no group**, so the rejecting `else` is structural
     rather than remembered; and
   * a gate that scans the repository's own gate files and fails on a listing narrowed by a bare
     `.filter()` or a `continue`-on-no-match, with an explicit allowlist entry — declared, with a
     reason — for any narrowing that is genuinely correct.
   The gate is itself subject to clause 1: its own contributing set is derived by shape.
4. **Ordering.** W2-INT-02 sits above every branch whose files it constrains, because a gate that
   quantifies over the repository is owned at the integration level
   ([ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md)) and because it would
   otherwise be red on every branch below it — the exact condition
   [ADR-0025](0025-the-route-inventory-is-partitioned-by-owner.md) rejected.

## Alternatives considered

* **Repeat ADR-0027 more loudly in the next brief.** Rejected: that is what round 2 was, and it
  produced six new instances. The defect is not that the rule is unknown; it is that finding every
  instance is a search, and a search is what a machine is for.
* **Ban `.filter()` on listings outright.** Rejected: some narrowings are correct and the ban would
  be routed around by a `for` loop with a `continue`, which is the same defect wearing different
  syntax — one of the six above is exactly that. The gate must catch the shape, not the method name.
* **Accept the six as declared gaps and move on.** Rejected for the three that are live fail-opens on
  a security gate (§42's alias expansion, the repository-provider set, the reachability pathspec).
  A gate that can be walked past is not a gate, and two of these were introduced by the round that
  was repairing this very class of defect.

## Consequences

* Round 3 briefs carry an enumeration duty, which makes them longer and the repairs slower.
* W2-INT-02 is a fifth task in a sub-wave planned for three, and it is added mid-wave. Recorded here
  rather than folded silently into an existing task's scope.
* An allowlist entry in the new gate is a shared mutable resource — precisely what ADR-0027 was
  written against. It is accepted only because each entry must carry a reason and the gate fails on
  an entry that no longer matches anything, so a stale exemption is loud rather than quiet. If that
  turns out to be optimistic, the entry mechanism is what to remove.
