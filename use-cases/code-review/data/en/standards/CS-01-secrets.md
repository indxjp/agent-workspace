# CS-01 No secrets in code

- Source: the development team's coding standard (fictional, a TypeScript server), rule 1
- Rule: never write a password, API token, key or other secret as a string in source code or tests. Read it from configuration (environment variables or a secret manager).

## Verdict

- OK: no added line holds a secret as a string.
- Caution: a string whose name or value does not tell whether it is a secret.
- NG: a value that reads as a token, password or key is written as a string.

## How to fix

Read the value from configuration such as `process.env`, and fail at start-up when it is missing.
