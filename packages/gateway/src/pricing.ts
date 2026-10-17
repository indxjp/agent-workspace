export type ModelPrice = Readonly<{
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  cacheReadUsdPerMillion?: string;
  cacheCreationUsdPerMillion?: string;
}>;

export type PricingCatalog = Readonly<{
  version: string;
  models: Readonly<Record<string, ModelPrice>>;
}>;

export type BillableUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}>;

const DECIMAL = /^(0|[1-9]\d{0,7})(?:\.(\d{1,6}))?$/u;

function rateMicros(value: string, label: string): bigint {
  const match = DECIMAL.exec(value);
  if (match === null) {
    throw new Error(`${label} must be a non-negative decimal with at most six places`);
  }
  return BigInt(match[1] ?? '0') * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

function safeCount(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return BigInt(value);
}

function formatUsdMicros(value: bigint): string {
  const dollars = value / 1_000_000n;
  const micros = value % 1_000_000n;
  return `${String(dollars)}.${String(micros).padStart(6, '0')}`;
}

/** Calculate USD with integer micro-dollar arithmetic and half-up rounding. */
export function calculateUsageCost(price: ModelPrice, usage: BillableUsage): string {
  const weighted =
    safeCount(usage.inputTokens, 'inputTokens') *
      rateMicros(price.inputUsdPerMillion, 'inputUsdPerMillion') +
    safeCount(usage.outputTokens, 'outputTokens') *
      rateMicros(price.outputUsdPerMillion, 'outputUsdPerMillion') +
    safeCount(usage.cacheReadInputTokens, 'cacheReadInputTokens') *
      rateMicros(
        price.cacheReadUsdPerMillion ?? price.inputUsdPerMillion,
        'cacheReadUsdPerMillion',
      ) +
    safeCount(usage.cacheCreationInputTokens, 'cacheCreationInputTokens') *
      rateMicros(
        price.cacheCreationUsdPerMillion ?? price.inputUsdPerMillion,
        'cacheCreationUsdPerMillion',
      );
  return formatUsdMicros((weighted + 500_000n) / 1_000_000n);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePrice(value: unknown, key: string): ModelPrice {
  if (!isRecord(value)) throw new Error(`pricing model ${key} must be an object`);
  const required = (name: string): string => {
    const item = value[name];
    if (typeof item !== 'string') throw new Error(`pricing model ${key}.${name} must be a string`);
    rateMicros(item, `pricing model ${key}.${name}`);
    return item;
  };
  const optional = (name: string): string | undefined => {
    const item = value[name];
    if (item === undefined) return undefined;
    if (typeof item !== 'string') throw new Error(`pricing model ${key}.${name} must be a string`);
    rateMicros(item, `pricing model ${key}.${name}`);
    return item;
  };
  const cacheReadUsdPerMillion = optional('cacheReadUsdPerMillion');
  const cacheCreationUsdPerMillion = optional('cacheCreationUsdPerMillion');
  return {
    inputUsdPerMillion: required('inputUsdPerMillion'),
    outputUsdPerMillion: required('outputUsdPerMillion'),
    ...(cacheReadUsdPerMillion === undefined ? {} : { cacheReadUsdPerMillion }),
    ...(cacheCreationUsdPerMillion === undefined ? {} : { cacheCreationUsdPerMillion }),
  };
}

/** Parse the deployment-owned, immutable model price catalogue. No live price is guessed. */
export function parsePricingCatalog(raw: string | undefined): PricingCatalog {
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error('GATEWAY_PRICING_JSON is required for authoritative usage settlement.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `GATEWAY_PRICING_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (
    !isRecord(decoded) ||
    typeof decoded['version'] !== 'string' ||
    !isRecord(decoded['models'])
  ) {
    throw new Error('GATEWAY_PRICING_JSON must contain string version and object models.');
  }
  const version = decoded['version'].trim();
  if (version.length === 0) throw new Error('GATEWAY_PRICING_JSON version must not be empty.');
  const models = Object.fromEntries(
    Object.entries(decoded['models']).map(([key, value]) => {
      if (!key.includes(':')) throw new Error(`pricing model key ${key} must be provider:model`);
      return [key, parsePrice(value, key)];
    }),
  );
  if (Object.keys(models).length === 0) {
    throw new Error('GATEWAY_PRICING_JSON must configure at least one model.');
  }
  return { version, models };
}

export function priceFor(catalog: PricingCatalog, provider: string, model: string): ModelPrice {
  const exact = catalog.models[`${provider}:${model}`];
  const wildcard = catalog.models[`${provider}:*`];
  const price = exact ?? wildcard;
  if (price === undefined) {
    throw new Error(
      `pricing catalogue ${catalog.version} has no entry for ${provider}:${model}; refusing zero-cost settlement`,
    );
  }
  return price;
}
