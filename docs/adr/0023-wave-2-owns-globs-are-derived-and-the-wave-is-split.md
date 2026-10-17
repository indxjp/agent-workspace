# ADR-0023 — Wave 2's task cards carry no `Owns` column, so the globs are derived here, and the wave is split into four sub-waves

Status: accepted
Date: 2026-09-04
Decided by: orchestrator
Scope: Wave 2 dispatch; the development plan §6.4

## Context

Wave 1's task table (plan §6.3) has an **Owns** column. Wave 2's (plan §6.4) does not — its fifth
column is **Spec**. Every other mechanism this programme depends on reads that column:

- [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) makes the PR's declared
  `Owns globs:` line the effective boundary, with the task card as the indicative source.
- `scripts/check-file-ownership.mjs` fails a PR whose diff leaves its declared globs.
- The pairwise-disjointness check that buys the parallelism has nothing to check.

So Wave 2 cannot be dispatched from its cards as written. The globs must come from somewhere, and
the only honest options are "derive them and say so" or "let each task choose its own", which is
how two tasks come to claim one file.

Wave 2 also has **twelve** tasks. At two agents per task — implementer and independent verifier,
which [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md) and every Wave 1 round
argue for — that is twenty-four agents in one dispatch, over this session's size guideline and, more
importantly, over the level at which a single integration branch can be reasoned about. Wave 1
already had to be split for this reason ([ADR-0013](0013-wave-1-ownership-split-and-substacks.md));
Wave 2 is larger.

## Decision

1. **The `Owns` globs for Wave 2 are derived by the orchestrator before dispatch and published in
   the Wave 2 plan.** They are checked pairwise disjoint at each
   parallel level, mechanically, and that check is part of the dispatch, not a review afterwards.
   Each is written on **one physical line** ([ADR-0022](0022-the-ownership-gate-reads-only-the-first-line.md)).
2. **A derived glob is indicative, exactly as a card is.** ADR-0018 still governs: a task that needs
   a file outside its glob declares it with a reason, and the declaration is the boundary provided it
   stays disjoint from its siblings.
3. **Wave 2 is split into four sub-waves**, each a separate dispatch on top of the previous one:

   | Sub-wave | Contents                                                         | Why separate                                                                             |
   | -------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
   | **2-R**  | R-06, R-12 research notes                                        | The plan's own §5 blocks W2-CP-05 on R-06 and the auth work on R-12; neither note exists |
   | **2a**   | Foundation: schema, persistence, the partitioned route inventory | Serial by construction — everything above imports it                                     |
   | **2b**   | The six backend resource tracks                                  | Parallel; disjoint globs; each is a vertical slice                                       |
   | **2c**   | The four UI tracks, then the integrator                          | Parallel, then serial                                                                    |

   2-R runs **concurrently with 2a**: research writes only `docs/research/**` and 2a writes no
   documentation, so the two stacks are disjoint and neither blocks the other.

4. **Wave 2's exit criterion is spec §47's, not the plan's**: a non-technical user deploys an agent
   with model, files, skills, MCP, permissions and sandbox, without editing code or configuration.
   The sandbox half belongs to Wave 3; that will be declared, not quietly dropped.

## Alternatives considered

- **Dispatch from the cards and let each task declare its own globs.** Rejected: it moves the
  disjointness check from before the wave to after the collision, which is the Wave 1a failure —
  five tracks green alone, seven failures on union.
- **Amend the development plan §6.4 in place to add the column.** Better in principle, and the
  plan file is a shared root-level artefact whose edit would collide with every task that touches
  it. The globs live in the Wave 2 plan instead, which is created by this wave and owned by
  the orchestrator. The plan is amended once, at the end, by the integrator.
- **Run all twelve tasks in one dispatch.** Rejected on the same grounds as ADR-0013, with more
  tasks.

## Consequences

- The plan's §6.4 table is now the _description_ of Wave 2 and the Wave 2 plan is its
  _dispatch_. Two documents can disagree; the wave plan wins for ownership and the specification
  wins for behaviour, per plan §2.3.
- Four dispatches means four integration points rather than one. That is the cost of the split, and
  it is paid in wall-clock rather than in correctness.
- Wave 3's cards **do** carry an `Owns` column, so this is a Wave 2-shaped defect and not a
  programme-wide one. It should be fixed in the plan for Waves 4–9 when a task next owns that file.
