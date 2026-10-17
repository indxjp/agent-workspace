export type DriverResult = {
  basis: string;
  values?: string[];
  unverified?: boolean;
  outOfScope?: boolean;
};

export type A10 = {
  drivers: string[];
  rows: string[][];
  legend: string;
};

export const NO_SCENARIO_ROWS: ReadonlySet<string>;
export function parseA10(spec: string): A10;
export function renderDriverMatrix(
  spec: string,
  results: Record<string, DriverResult>,
): Promise<string>;
