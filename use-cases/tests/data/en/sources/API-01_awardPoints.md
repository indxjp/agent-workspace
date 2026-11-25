# API-01 awardPoints (member app)

The point award function. The module is `src/points/award.ts`.

```ts
export function awardPoints(amountYen: number, rank: string): number;
export class PointError extends Error {
  readonly code: 'INVALID_AMOUNT' | 'UNKNOWN_RANK';
}
```

- It returns the number of points to award (a whole number).
- On a wrong input it throws `PointError`; `code` names the kind of error.
