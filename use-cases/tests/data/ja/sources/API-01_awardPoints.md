# API-01 awardPoints（会員アプリ）

ポイント付与の関数。モジュールは `src/points/award.ts`。

```ts
export function awardPoints(amountYen: number, rank: string): number;
export class PointError extends Error {
  readonly code: 'INVALID_AMOUNT' | 'UNKNOWN_RANK';
}
```

- 戻り値は付与するポイントの数（整数）。
- 入力が誤っているときは、`PointError` を投げる。`code` がエラーの種類。
