export interface Known {
  lane: string;
  where: string;
  issue: number;
}

export function parseKnown(value: unknown): Known[];

export function verdict(
  lanes: readonly {
    name: string;
    rows: readonly { where: string; what: string; result: string }[] | null;
  }[],
  known?: readonly Known[],
): { outcome: 'pass' | 'skipped' | 'fail'; markdown: string; digest: string };
