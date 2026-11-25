# STD-01 Test design rules (Development)

A test design document holds the test cases drawn from a spec and a draft of the test code. A person reviews it before it is used.

## Test cases

- IDs run from `TC-01`. One case is one input and one expected result.
- Each case has its requirement (REQ-xx), its kind (normal, boundary, error or regression), the input, the expected result and its source.
- An expected result is only a value written in the spec's examples (EX-xx). For an input no example covers, write "to be confirmed" as the expected result and list it as an open point. Never compute an expected result yourself.
- A requirement with a boundary (a remainder, a cap) always gets a case at the boundary value.
- Each defect in the defect list (BUG-xx) gets one regression case with the same input.

## Draft test code

- Write it for Vitest. `describe` is the function's name; one `it` per case, named by the TC ID and its kind.
- An error case uses `expect(() => ...).toThrow(...)` and checks the error code.
- The draft has not been run. A person runs it and checks it.

## Open points

- What the spec leaves undecided (a requirement whose annex has not arrived, for example) is not made a test case: list it as an open point.
