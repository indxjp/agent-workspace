# L-contracts-runs — run and session wire contracts

## Scope

`Contracts/Runs.lean` preserves the Phase-0 `RunStatus`, its `WireEnum`, `terminal`, and
`isTerminal` declarations. The added model transcribes the strict Zod shapes in
`packages/contracts/src/runs.ts`: usage, cost, run resource, start request, start response, run and
interrupt responses, revoke response, and the paged list response. It also models every enumeration
and limit in that module and the ten optional list query fields in their serialization order.
`Contracts/Sessions.lean` covers the session resource and response envelopes consumed by resume. Its `derivedResumable`
function records the server's stronger rule; the Zod schema itself only validates a boolean.

The schema codecs use `JValue` as their value type because these Zod schemas transform no field.
`checked` supplies `decode_encode` and `valid_of_decode`; the field predicates enforce required
keys, strict rejection of unknown keys, nullable values, integer bounds, UUIDs, ISO instants, and
the start request's paired model override. This retains absent versus `null` and makes exact parsed
JSON observable in the differential suite.

## Theorems and vectors

- T0: round trips for all modeled schema codecs; fixed export constants; blank, unpaired, unknown
  key, negative count, and unknown outcome rejections; null model pair acceptance; query omission
  and ordering.
- T1: the 202 response's run and events envelope, the `runs` list envelope, nonempty cursor, and
  archived sessions' derived non-resumability.
- T4: `decimalCostTarget` refines today's cost schema, with the concrete witness `"not-money"`.
- `Vectors/ContractsRuns.lean` emits schema vectors and query serialization vectors. The Vitest
  suite replays them against the real `@indx-workspace/contracts/runs` and `/sessions` exports.

## Finding

**F-067 (already recorded):** `RunCostSchema` accepts any nonempty `amount` and `currency`, while
its source comment and SPEC §4 call the amount a decimal string and the currency USD. The
`current_accepts_non_decimal` theorem and `RunCostSchema/nondecimal` differential vector pin today's
behavior. A decimal restriction would change the wire contract, so this unit records the divergence
for triage instead of altering product code.

## Verification

The named Lean targets `Contracts.{Runs,Sessions}`, the T0/T1/T4 modules, and
`Vectors.ContractsRuns` built. The family-only generator produced `schemas.json` and `query.json`.
`pnpm exec vitest run tests/formal/contracts-runs.test.ts` passed **54/54** vectors and pinning
checks against the real exported TypeScript. No whole-package Lake build was run because another
formal unit shares `.lake`.

Six definition mutations each made the named T0 build fail, and each was restored before the next
mutation. The unmutated T0/T1/T4/vector build passed afterward.

| Definition mutation                         | Killing theorem                        |
| ------------------------------------------- | -------------------------------------- |
| `maxPromptChars` 100000 → 99999             | `constants_match_exports`              |
| final model provider spelling changed       | `constants_match_exports`              |
| blank prompt check replaced by `true`       | `start_request_refuses_blank`          |
| paired model check replaced by `true`       | `start_request_refuses_unpaired_model` |
| strict request key check replaced by `true` | `start_request_refuses_unknown_key`    |
| nonnegative integer minimum 0 → −1          | `revoke_refuses_negative_count`        |

An independent second pass found seven schema mutations that survived the original generic codec
round-trip theorems. Seven predicate-specific T0 statements were added with accepted and refused
values: required usage `toolCalls`, resource status membership, resource ISO creation time,
request session UUID, prompt UTF-16 maximum, nonempty paired model, and session `resumable` Boolean.
The 100001-character prompt vector is the concrete over-limit witness for the general maximum
theorem. All seven mutations then failed the named T0 build, each was restored byte-for-byte.
A further independent pass found four surviving changes: empty cost currency, negative usage
`totalTokens`, swapped `from`/`to` query values, and a new `paused` session status. Direct T0
statements with valid and invalid witnesses now kill all four. Sources were restored byte-for-byte
and the clean named vector build passed. The combined ContractsRuns, AuthzRunToken and RunCompose
`lake exe axioms` audit passed for 1,315 declarations; `lake exe imports` passed for 30 edges;
93 source citations resolved. The focused real replay passed 109 tests across those families,
with five database-backed tests skipped because `TEST_DATABASE_URL` was not set.

## Coverage against D1

| Checklist                                                  | Evidence                                                                     | Remaining relation                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| C-9–C-14 status, provider, accounting and prompt constants | Phase-0 `RunStatus`; `constants_match_exports`; real-export pinning test     | Server model and prompt parser equivalence belong to RunCompose.                            |
| C-15–C-18 usage, cost, resource, start request             | T0 codec round trips and rejection witnesses; schema vectors                 | `renderRun` and server `parseStartRunBody` equivalence belong to Behaviour and RunCompose.  |
| C-19–C-25 success envelopes and list limits                | T0 round trips, T1 envelope witnesses, constants and schema vectors          | Cursor ordering and page transitions belong to Behaviour.                                   |
| C-26–C-27 query and renderer                               | `RunListQuery`, `list_query_*`, query vectors                                | The TypeScript interface accepts nonintegral limits; route validation belongs to Behaviour. |
| S-21 money                                                 | T4 `current_accepts_non_decimal`; F-067                                      | Triage decides whether to change the public schema.                                         |
| S-22 wrapped responses                                     | T1 `start_202_contract`, `list_envelope_refuses_items_key`; envelope vectors | Handler paths belong to Behaviour.                                                          |
| S-31 session resource                                      | `Sessions.resource`, response codecs, vectors                                | The server's derived `resumable` is a RunCompose obligation.                                |
| S-33–S-35 status/resource/start shape                      | Phase-0 status, T0 codecs and vectors                                        | Route semantics belong to Behaviour.                                                        |

## Limits

The contracts intentionally do not check that `RunUsage.totalTokens` sums the four counters,
`RunResource` timestamps follow lifecycle order, `events` is a particular path, or a cursor is
well-formed. Those are server and lifecycle obligations, not conditions of these Zod schemas. The
model's `RunListQuery` uses `Int` for the optional limit; the TypeScript interface accepts any
number, but the values exercised here are integral route values.
