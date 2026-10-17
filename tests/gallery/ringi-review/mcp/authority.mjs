// The authority matrix (職務権限規程) as data: parsed from the rule book's own Markdown so that the
// table people read and the table code applies are the same text. Pure functions, no I/O: the MCP
// server (`check_authority`) and the backend (which re-checks the agent's 決裁区分) both use it.

/** `300万円以下` → 3,000,000; `3,000万円超` → null (no upper bound). */
function upperBound(cell) {
  const match = /^([\d,]+)万円(以下|超)$/u.exec(cell.normalize('NFKC').replace(/\s/gu, ''));
  if (match === null) throw new Error(`unreadable amount in the authority matrix: ${cell}`);
  return match[2] === '超' ? null : Number(match[1].replace(/,/gu, '')) * 10_000;
}

/**
 * Read every `## §N.N <区分>` section that holds a `| 金額 | 決裁者 |` table. A `合議: X` line in
 * the section names the department head who must co-review.
 */
export function parseAuthorityMatrix(markdown) {
  const front = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  const title = /^title:\s*(.+)$/mu.exec(front?.[1] ?? '')?.[1]?.trim() ?? '職務権限規程';
  const categories = [];
  let current = null;
  for (const line of markdown.split('\n')) {
    const heading = /^## §(\S+)\s+(.+)$/u.exec(line);
    if (heading) {
      current = { category: heading[2].trim(), section: heading[1], tiers: [], coReview: null };
      categories.push(current);
      continue;
    }
    if (current === null) continue;
    const coReview = /^合議[:：]\s*(.+)$/u.exec(line.trim());
    if (coReview) {
      current.coReview = coReview[1].trim();
      continue;
    }
    const row = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/u.exec(line.trim());
    if (row === null || row[1].startsWith('金額') || row[1].startsWith('---')) continue;
    current.tiers.push({ maxYen: upperBound(row[1]), approver: row[2], label: row[1] });
  }
  return { source: title, categories: categories.filter((entry) => entry.tiers.length > 0) };
}

/** The category names the matrix defines, in the rule book's order. */
export function categoriesOf(matrix) {
  return matrix.categories.map((entry) => entry.category);
}

/**
 * The approver the matrix requires for `amountYen` (税抜, §2.1) in `category`, with the clause to
 * cite. Returns null for a category the matrix does not define; throws for an invalid amount.
 */
export function requiredApprover(matrix, category, amountYen) {
  if (!Number.isSafeInteger(amountYen) || amountYen < 0) {
    throw new Error('amountYen must be a non-negative integer number of yen');
  }
  const entry = matrix.categories.find((candidate) => candidate.category === category);
  if (entry === undefined) return null;
  const tier = entry.tiers.find(
    (candidate) => candidate.maxYen === null || amountYen <= candidate.maxYen,
  );
  if (tier === undefined) throw new Error(`the ${category} table has no tier above its last limit`);
  return {
    category,
    amountYen,
    approver: tier.approver,
    route: `${tier.approver}決裁`,
    tier: tier.label,
    coReview: entry.coReview,
    clause: `〔${matrix.source} §${entry.section}〕`,
  };
}
