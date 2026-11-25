// Generated from each entry's surfaces by `APPS_WRITE=1 pnpm vitest run --project tests-store tests/store/result-charts.test.ts`.
// Do not edit by hand: tests/store/result-charts.test.ts fails when it differs from the surfaces.

/**
 * The result charts (ADR-0168) each entry's demo agent's surfaces declare, keyed by slug. Data: the
 * Try it section parses it with the contracts' `ResultChartsSchema` before it draws any.
 */
export const RESULT_CHARTS: Readonly<Record<string, readonly unknown[]>> = {
  "lead-priority": [
    {
      "kind": "bar",
      "field": "leads",
      "label": "company",
      "value": "score",
      "title": {
        "ja": "リードの点数",
        "en": "Lead scores"
      },
      "axes": {
        "label": {
          "ja": "会社",
          "en": "Company"
        },
        "value": {
          "ja": "点数",
          "en": "Score"
        }
      }
    },
    {
      "kind": "bar",
      "field": "sources",
      "label": "source",
      "value": "averageScore",
      "title": {
        "ja": "流入元ごとの平均点",
        "en": "Average score by source"
      },
      "axes": {
        "label": {
          "ja": "流入元",
          "en": "Source"
        },
        "value": {
          "ja": "平均点",
          "en": "Average"
        }
      }
    }
  ],
  "territory": [
    {
      "kind": "bar",
      "field": "territories",
      "label": "territory",
      "value": "value",
      "title": {
        "ja": "エリア別の配分（均等にした指標）",
        "en": "Each territory (the balanced measure)"
      },
      "axes": {
        "label": {
          "ja": "エリア",
          "en": "Territory"
        },
        "value": {
          "ja": "値",
          "en": "Value"
        }
      }
    }
  ],
  "survey": [
    {
      "kind": "bar",
      "field": "questions",
      "label": "question",
      "value": "favourable",
      "title": {
        "ja": "設問別の好意的な回答の割合（%）",
        "en": "Favourable answers by question (%)"
      },
      "axes": {
        "label": {
          "ja": "設問",
          "en": "Question"
        },
        "value": {
          "ja": "割合",
          "en": "Share"
        }
      }
    },
    {
      "kind": "bar",
      "field": "channels",
      "label": "channel",
      "value": "overall",
      "title": {
        "ja": "窓口別の総合満足度（平均）",
        "en": "Overall satisfaction by channel (mean)"
      },
      "axes": {
        "label": {
          "ja": "窓口",
          "en": "Channel"
        },
        "value": {
          "ja": "平均",
          "en": "Mean"
        }
      }
    }
  ],
  "supplier": [
    {
      "kind": "bar",
      "field": "suppliers",
      "label": "supplier",
      "value": "defectPpm",
      "title": {
        "ja": "仕入先別の不良率（当月・ppm）",
        "en": "Defect rate by supplier (month, ppm)"
      },
      "axes": {
        "label": {
          "ja": "仕入先",
          "en": "Supplier"
        },
        "value": {
          "ja": "ppm",
          "en": "ppm"
        }
      }
    },
    {
      "kind": "line",
      "field": "trend",
      "label": "month",
      "value": "defectPpm",
      "title": {
        "ja": "全仕入先の不良率の推移（ppm）",
        "en": "All suppliers’ defect rate (ppm)"
      },
      "axes": {
        "label": {
          "ja": "月",
          "en": "Month"
        },
        "value": {
          "ja": "ppm",
          "en": "ppm"
        }
      }
    }
  ],
  "spare-parts": [
    {
      "kind": "bar",
      "field": "toOrder",
      "label": "partNo",
      "value": "order",
      "title": {
        "ja": "発注する数量（部品別）",
        "en": "Quantity to order by part"
      },
      "axes": {
        "label": {
          "ja": "部品番号",
          "en": "Part"
        },
        "value": {
          "ja": "数量",
          "en": "Quantity"
        }
      }
    },
    {
      "kind": "line",
      "field": "trend",
      "label": "month",
      "value": "used",
      "title": {
        "ja": "月別の部品使用数",
        "en": "Parts used by month"
      },
      "axes": {
        "label": {
          "ja": "月",
          "en": "Month"
        },
        "value": {
          "ja": "使用数",
          "en": "Used"
        }
      }
    }
  ],
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
  ],
  "cash": [
    {
      "kind": "line",
      "field": "weeks",
      "label": "week",
      "value": "closing",
      "title": {
        "ja": "週末の残高（円）",
        "en": "Closing balance by week (yen)"
      },
      "axes": {
        "label": {
          "ja": "週末日",
          "en": "Week ending"
        },
        "value": {
          "ja": "残高",
          "en": "Balance"
        }
      }
    },
    {
      "kind": "bar",
      "field": "weeks",
      "label": "week",
      "value": "net",
      "title": {
        "ja": "週ごとの収支（円）",
        "en": "Net flow by week (yen)"
      },
      "axes": {
        "label": {
          "ja": "週末日",
          "en": "Week ending"
        },
        "value": {
          "ja": "収支",
          "en": "Net"
        }
      }
    }
  ],
  "pulse": [
    {
      "kind": "bar",
      "field": "teams",
      "label": "team",
      "value": "favourable",
      "title": {
        "ja": "部署別の好意的な回答の割合（%）",
        "en": "Favourable answers by team (%)"
      },
      "axes": {
        "label": {
          "ja": "部署",
          "en": "Team"
        },
        "value": {
          "ja": "割合",
          "en": "Share"
        }
      }
    },
    {
      "kind": "bar",
      "field": "questions",
      "label": "question",
      "value": "favourable",
      "title": {
        "ja": "設問別の好意的な回答の割合（%）",
        "en": "Favourable answers by question (%)"
      },
      "axes": {
        "label": {
          "ja": "設問",
          "en": "Question"
        },
        "value": {
          "ja": "割合",
          "en": "Share"
        }
      }
    }
  ],
  "assets": [
    {
      "kind": "bar",
      "field": "licences",
      "label": "product",
      "value": "gap",
      "title": {
        "ja": "ライセンスの過不足（導入数−保有数）",
        "en": "Licence gap (installed − owned)"
      },
      "axes": {
        "label": {
          "ja": "製品",
          "en": "Product"
        },
        "value": {
          "ja": "過不足",
          "en": "Gap"
        }
      }
    }
  ],
  "logs": [
    {
      "kind": "line",
      "field": "buckets",
      "label": "start",
      "value": "errors",
      "title": {
        "ja": "時間帯別のエラー件数",
        "en": "Errors by time"
      },
      "axes": {
        "label": {
          "ja": "時刻",
          "en": "Time"
        },
        "value": {
          "ja": "エラー",
          "en": "Errors"
        }
      }
    }
  ],
  "sql": [
    {
      "kind": "bar",
      "field": "rows",
      "label": "group",
      "value": "total",
      "title": {
        "ja": "クエリの結果",
        "en": "The query result"
      },
      "axes": {
        "label": {
          "ja": "グループ",
          "en": "Group"
        },
        "value": {
          "ja": "合計",
          "en": "Total"
        }
      }
    }
  ],
  "okr": [
    {
      "kind": "bar",
      "field": "keyResults",
      "label": "kr",
      "value": "progress",
      "title": {
        "ja": "主要な結果ごとの進捗率（%）",
        "en": "Progress by key result (%)"
      },
      "axes": {
        "label": {
          "ja": "主要な結果",
          "en": "Key result"
        },
        "value": {
          "ja": "進捗率",
          "en": "Progress"
        }
      }
    }
  ],
  "kpi": [
    {
      "kind": "bar",
      "field": "changes",
      "label": "metric",
      "value": "changePct",
      "title": {
        "ja": "指標別の前週比（%）",
        "en": "Change on the previous week by metric (%)"
      },
      "axes": {
        "label": {
          "ja": "指標",
          "en": "Metric"
        },
        "value": {
          "ja": "前週比",
          "en": "Change"
        }
      }
    }
  ],
  "forecast": [
    {
      "kind": "bar",
      "field": "months",
      "label": "month",
      "value": "forecast",
      "title": {
        "ja": "月別の着地見込み（円）",
        "en": "Forecast by month (yen)"
      },
      "axes": {
        "label": {
          "ja": "月",
          "en": "Month"
        },
        "value": {
          "ja": "見込み",
          "en": "Forecast"
        }
      }
    },
    {
      "kind": "bar",
      "field": "deals",
      "label": "deal",
      "value": "weighted",
      "title": {
        "ja": "商談中の案件の加重金額（円）",
        "en": "Weighted amount of open deals (yen)"
      },
      "axes": {
        "label": {
          "ja": "案件",
          "en": "Deal"
        },
        "value": {
          "ja": "加重金額",
          "en": "Weighted"
        }
      }
    }
  ],
  "dash-narrator": [
    {
      "kind": "bar",
      "field": "changes",
      "label": "metric",
      "value": "changePct",
      "title": {
        "ja": "指標別の変化率（%）",
        "en": "Change by metric (%)"
      },
      "axes": {
        "label": {
          "ja": "指標",
          "en": "Metric"
        },
        "value": {
          "ja": "変化率",
          "en": "Change"
        }
      }
    }
  ],
  "segments": [
    {
      "kind": "bar",
      "field": "segments",
      "label": "segment",
      "value": "customers",
      "title": {
        "ja": "セグメント別の顧客数",
        "en": "Customers by segment"
      },
      "axes": {
        "label": {
          "ja": "セグメント",
          "en": "Segment"
        },
        "value": {
          "ja": "顧客数",
          "en": "Customers"
        }
      }
    },
    {
      "kind": "bar",
      "field": "segments",
      "label": "segment",
      "value": "revenue",
      "title": {
        "ja": "セグメント別の売上（円）",
        "en": "Revenue by segment (yen)"
      },
      "axes": {
        "label": {
          "ja": "セグメント",
          "en": "Segment"
        },
        "value": {
          "ja": "売上",
          "en": "Revenue"
        }
      }
    }
  ],
  "pricing": [
    {
      "kind": "bar",
      "field": "products",
      "label": "productName",
      "value": "revenueChange",
      "title": {
        "ja": "商品別の売上の増減の試算（円）",
        "en": "Estimated revenue change (yen)"
      },
      "axes": {
        "label": {
          "ja": "商品",
          "en": "Product"
        },
        "value": {
          "ja": "増減",
          "en": "Change"
        }
      }
    },
    {
      "kind": "line",
      "field": "trend",
      "label": "month",
      "value": "revenue",
      "title": {
        "ja": "月別の売上（円）",
        "en": "Revenue by month (yen)"
      },
      "axes": {
        "label": {
          "ja": "月",
          "en": "Month"
        },
        "value": {
          "ja": "売上",
          "en": "Revenue"
        }
      }
    }
  ],
  "churn": [
    {
      "kind": "bar",
      "field": "atRisk",
      "label": "accountName",
      "value": "signCount",
      "title": {
        "ja": "兆候のある顧客（兆候の数）",
        "en": "Accounts with signs (number of signs)"
      },
      "axes": {
        "label": {
          "ja": "顧客",
          "en": "Account"
        },
        "value": {
          "ja": "兆候",
          "en": "Signs"
        }
      }
    },
    {
      "kind": "bar",
      "field": "accounts",
      "label": "accountName",
      "value": "adoption",
      "title": {
        "ja": "顧客別の利用率（%）",
        "en": "Adoption by account (%)"
      },
      "axes": {
        "label": {
          "ja": "顧客",
          "en": "Account"
        },
        "value": {
          "ja": "利用率",
          "en": "Adoption"
        }
      }
    }
  ]
};
