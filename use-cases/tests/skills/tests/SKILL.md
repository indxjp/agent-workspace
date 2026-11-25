---
name: tests
description: The sections of a test design document (scope, test cases, draft test code, open points), how each test case is drawn from the spec's requirements and examples and the defect list, and how the draft code is shaped.
---

# A test design document

Four sections, in this order. Every test case and every point names the ids it rests on: a
requirement (`REQ-01`), an example (`EX-03`), a defect (`BUG-0311`), the rules (`STD-01`) or the
function's shape (`API-01`).

1. **Scope** (`対象と前提` / `Scope`). The spec's id, title and version, the function and its module
   from `API-01`, and that the draft has not been run. In typed output, `spec` is the bare id
   (`SPEC-12`), without its title.
2. **Test cases** (`テストケース` / `Test cases`). A table with the header
   `TC, 要件, 観点, 入力, 期待結果, 根拠` / `TC, Requirement, Kind, Input, Expected, Source`:
   - one case per example `EX-xx`, in the spec's order, its expected result copied from the example
     (a number, or the error code);
   - the kind per `STD-01`: `境界` / `boundary` for a remainder or cap value (EX-01, EX-02, EX-03,
     EX-05, EX-06), `異常` / `error` for an error, `正常` / `normal` otherwise;
   - one `回帰` / `regression` case per `BUG-xx` row, with the defect's input and the example its
     fix names as the expected result;
   - when the request asks for a subset (only the error cases, for example), only those rows.
   At most 1,000 rows (the `office-writer` limit).
3. **Draft test code** (`テストコードの下書き` / `Draft test code`). Vitest: one `describe('awardPoints')`
   block per kind, one `it('TC-xx <kind>')` per case, `expect(awardPoints(amount, rank)).toBe(n)`
   for a number and `expect(() => awardPoints(amount, rank)).toThrow(expect.objectContaining({ code }))`
   for an error, importing from the module `API-01` names.
4. **Open points** (`確認事項` / `Open points`). What the spec leaves undecided (`REQ-06`'s annex), and
   any case whose expected result is `要確認` / `to be confirmed`.
