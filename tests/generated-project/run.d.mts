export const REGISTRY_IMAGE: string;
export function nodeImageOf(dockerfile: string): string;
export function positiveIntegerVariable(
  name: string,
  fallback: number,
  options?: { max?: number },
  environment?: Readonly<Record<string, string | undefined>>,
): number;
