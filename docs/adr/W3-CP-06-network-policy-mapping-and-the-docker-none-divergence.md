# W3-CP-06 — The §15.2 network-policy mapping is derived data, and `docker`'s `none` divergence is one declared, exact addition to a spec-derived set

Status: accepted
Date: 2026-09-06
Decided by: W3-CP-06 (runtime profiles CRUD and network-policy data)
Scope: `apps/web/server/runtimes/network-policy.ts`, `apps/web/server/runtimes/network-policy.test.ts`

## Context

Spec §15.2 maps `networkPolicy` to eight drivers × three policies, and states a rule ten lines
below its own table: _"`none` must always mean 'the gateway and nothing else', never 'no network at
all'"_ (`docs/spec.md:1045`). The Wave 3 plan's "What this plan corrects" item 6 records
that §15.2's own `docker` × `none` cell — `` `--network none` `` — contradicts that rule, measured:

```console
$ docker run --rm --network none alpine:3.20 sh -c 'ip addr show | grep -E "^[0-9]+:"; wget -q -T 3 -O- http://192.168.65.254:4000/'
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN qlen 1000
wget: can't connect to remote host (192.168.65.254): Network unreachable
$ echo $?
1
```

A `--network none` container reaches no address at all — literally "no network at all", the
phrase §15.2's own rule forbids. §15.2's remedy paragraph (`docs/spec.md:1047`) describes exactly
this shape — _"drivers whose egress control is a single all-or-nothing switch"_ — for three other
drivers (`aca-sessions`, `aws-agentcore`, `cloud-run-sandbox`) and omits `docker`. This task's cell
requires storing the mapping **as data** so the UI can render what each driver actually enforces,
and requires a second test asserting §15.2's rule directly, with any cell contradicting it carrying
a non-empty divergence.

W3-RT-01's own round 1 failed on exactly the mistake this task is most likely to repeat: hard-coding
a list a parser had already produced. This record is how that lesson is applied here.

## Decision

1. **Every cell's `specCellText` is transcribed verbatim from §15.2's own table**, including
   `docker`'s — the cell is the specification, and staying wrong on paper while being right in the
   driver is what the plan's "What this plan corrects" item 6 asks for. A dedicated test
   (`network-policy.test.ts`) parses §15.2's markdown table out of `docs/spec.md` at run time and
   asserts equality cell by cell, never transcribed by hand a second time.
2. **The set of drivers whose `none` cell carries a divergence is derived, not retyped, with one
   named, declared exception.** The three-driver "all-or-nothing switch" list is extracted from
   §15.2's own remedy-paragraph sentence by regex, so a driver added to that sentence is picked up
   without an edit here. `docker` is not in that sentence — it is the specification defect the plan
   records — so it is added to the derived set as one explicit, named union
   (`derivedFromSpec.add('docker')`), asserted as an **exact set** against the data
   (`network-policy.test.ts`'s "the exact set of drivers needing a `none` divergence" test), per
   ADR-0031: an exclusion or addition to a derived set must be a declaration that cannot grow
   silently, never an implicit one.
3. **§15.2's rule sentence itself is parsed, not copied.** `NONE_MEANING` is asserted equal to the
   phrase extracted from `` `none` must always mean "X", never "Y" ``, and every row's `noneMeaning`
   is asserted equal to the same extracted phrase — so a wording change in §15.2 breaks the test
   that would otherwise silently keep comparing against a stale copy.
4. **A row with no divergence never recites the forbidden meaning either**, asserted directly: a
   guard against this file's own classification being wrong in the safe direction.

## Verification (ADR-0029)

The gate was watched failing on a tree it ought to reject, not merely read: `docker`'s
`specCellText` was corrupted to `'--network NONE-CORRUPTED'` and the "every policy cell equals
§15.2's own text" test failed by name, quoting the exact spec cell it expected. The change was then
reverted and the suite re-run green (23/23). The all-or-nothing-driver regex was itself corrected
during this work after it initially matched `` `--allow-egress` `` out of `cloud-run-sandbox`'s own
parenthetical (a driver id and a flag both appear backtick-quoted in the same sentence); anchoring
the pattern on a leading letter — a driver id never begins with a hyphen — fixed it without a
hand-picked exclusion list.

## Consequences

- This file and `packages/runtime/src/docker.ts` (W3-RT-03, 3b-1) describe **one** behaviour: the
  stored cell stays `` `--network none` `` because it is the specification; the divergence records
  `--network agent-egress`, the measured probe above, and the citation to §15.2's rule at
  `docs/spec.md:1045` — exactly what W3-RT-03's own Accept line asks the driver to implement.
- §15.2's specification defect is carried forward, not fixed here: `docs/spec.md` is in no Wave 3
  `Owns` cell (plan §2.3), so the resolution belongs to whoever owns §15.2, per
  § What Wave 3 does not close, item 6.
- A fifth driver's `none` cell turning out to need a divergence in a future wave fails this file's
  exact-set assertion by name, rather than silently passing with an incomplete UI.
