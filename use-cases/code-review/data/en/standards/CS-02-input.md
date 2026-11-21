# CS-02 Validate values from outside

- Source: coding standard, rule 2
- Rule: a value that comes from outside (an HTTP request, a file, a queue message) is validated with a schema (zod) before it is used.

## Verdict

- OK: values from outside are validated with a schema before use, or the diff has no value from outside.
- Caution: the diff does not show where a value comes from (a function argument, for example).
- NG: a value from outside is used without validation.

## How to fix

Pass it through the schema's `parse` at the entry point, and hand on only the validated value.
