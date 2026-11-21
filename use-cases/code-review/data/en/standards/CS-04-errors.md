# CS-04 Never swallow an exception

- Source: coding standard, rule 4
- Rule: a caught exception is logged and rethrown, or returned as a typed error. Never return an empty value and carry on.

## Verdict

- OK: no `catch`, or the exception is logged and rethrown, or returned as a typed error.
- Caution: it is logged, but the caller never learns of the failure.
- NG: the `catch` logs nothing and returns an empty value or the same value as a success.

## How to fix

Log in `catch (error)` and `throw error;`, or return an error the caller can tell apart.
