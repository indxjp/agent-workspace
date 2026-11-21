// Generated from each entry's surfaces by `APPS_WRITE=1 pnpm vitest run --project tests-store tests/store/result-charts.test.ts`.
// Do not edit by hand: tests/store/result-charts.test.ts fails when it differs from the surfaces.

/**
 * The result charts (ADR-0168) each entry's demo agent's surfaces declare, keyed by slug. Data: the
 * Try it section parses it with the contracts' `ResultChartsSchema` before it draws any.
 */
export const RESULT_CHARTS: Readonly<Record<string, readonly unknown[]>> = {
  "budget": [
    {
      "kind": "bar",
      "field": "departments",
      "label": "department",
      "value": "variance",
      "title": {
        "ja": "部門別の差異（当月・円）",
        "en": "Variance by department (month, yen)"
      },
      "axes": {
        "label": {
          "ja": "部門",
          "en": "Department"
        },
        "value": {
          "ja": "差異",
          "en": "Variance"
        }
      }
    },
    {
      "kind": "line",
      "field": "trend",
      "label": "month",
      "value": "variance",
      "title": {
        "ja": "月別の差異（円）",
        "en": "Variance by month (yen)"
      },
      "axes": {
        "label": {
          "ja": "月",
          "en": "Month"
        },
        "value": {
          "ja": "差異",
          "en": "Variance"
        }
      }
    }
  ]
};
