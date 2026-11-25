# CS-06 A change in behaviour comes with tests

- Source: coding standard, rule 6
- Rule: a change that adds or changes behaviour adds or changes a test (`*.test.ts`) in the same patch.

## Verdict

- OK: the patch adds or changes a test file that checks the changed behaviour.
- Caution: there is a test file, but it does not check the changed behaviour.
- NG: the change alters behaviour and the patch adds or changes no test file.

## How to fix

Add `<name>.test.ts` next to the changed file, checking both the success and the failure cases.
