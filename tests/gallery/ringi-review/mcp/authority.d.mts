// Types for the authority matrix module, which is plain JavaScript so the MCP server runs with Node
// alone. The backend and the tests import it through these declarations.
export interface AuthorityTier {
  /** The tier's upper bound in yen (inclusive), or null for the open-ended top tier. */
  readonly maxYen: number | null;
  readonly approver: string;
  /** The amount cell as the rule book writes it, such as `3,000万円以下`. */
  readonly label: string;
}

export interface AuthorityCategory {
  readonly category: string;
  readonly section: string;
  readonly tiers: readonly AuthorityTier[];
  readonly coReview: string | null;
}

export interface AuthorityMatrix {
  readonly source: string;
  readonly categories: readonly AuthorityCategory[];
}

export interface AuthorityDecision {
  readonly category: string;
  readonly amountYen: number;
  readonly approver: string;
  /** The 決裁区分 as written on a review sheet, such as `本部長決裁`. */
  readonly route: string;
  readonly tier: string;
  readonly coReview: string | null;
  /** The clause to cite, such as `〔職務権限規程 §3.1〕`. */
  readonly clause: string;
}

export function parseAuthorityMatrix(markdown: string): AuthorityMatrix;
export function categoriesOf(matrix: AuthorityMatrix): string[];
export function requiredApprover(
  matrix: AuthorityMatrix,
  category: string,
  amountYen: number,
): AuthorityDecision | null;
