/**
 * The one catalog every model-selection surface reads — issue #130.
 *
 * `#129` normalised `GET /api/models` into one row per provider-side model a *ready* connection
 * actually offers (`{connectionId, providerModelId, displayName, capabilities}`), and separated the
 * connection view onto `GET /api/model-connections` (see that route's own header). Before this
 * task nothing joined the two: every screen that let a person choose a model read either the
 * connection list alone (and treated a connection's `config.deployment` as if it were the model —
 * `#130`'s own regression, non-Azure selections have no `deployment`, so the "model" persisted was
 * always `null`) or nothing at all. {@link readCatalog} is the one place the two responses are
 * joined into a single `(connectionId, providerModelId)` pair a caller can select and persist by
 * id — never by a label, never by guessing a field that only one provider happens to populate.
 *
 * `capabilities` on {@link CatalogModel} is copied verbatim from `#129`'s own discovery adapter
 * output. Nothing here re-derives or guesses one: the "existing hardcoded capability guesses" the
 * issue names (`provider === 'openai' ? supported : unverified`) are gone, not replaced with a
 * better guess.
 */
import {
  connectionStatus,
  providerLabel,
  readModelConnections,
  type ModelConnectionView,
} from './model';

/** `#129`'s `DiscoveredModel['capabilities']`, transcribed rather than imported — this module (a
 *  client component's dependency) must never pull in `server/models/discovery.ts`, which reaches
 *  the Node-only gateway registry. Kept structurally identical; `catalog.test.ts` proves it against
 *  a real discovery-shaped fixture. */
interface CatalogModelCapabilities {
  readonly streaming: boolean;
  readonly toolUse: boolean;
  readonly thinking: boolean;
  readonly promptCaching: boolean;
  readonly structuredOutput: boolean;
  readonly contextManagement: boolean;
  readonly webSearch: boolean;
  readonly tokenCounting: boolean;
}

/** One selectable `(connection, model)` pair — a joined row of `GET /api/models` and `GET /api/model-connections`. */
export interface CatalogModel {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly provider: ModelConnectionView['provider'];
  readonly providerModelId: string;
  readonly displayName: string;
  readonly capabilities: CatalogModelCapabilities;
}

/** A connection this workspace has that currently offers no selectable model, and why. */
interface UnavailableConnection {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly reason: string;
}

/** The value every layer stores and sends: a connection id paired with a provider-side model id, or
 *  `null` for "no selection at this layer — inherit from the next one down". Structurally identical
 *  to `server/runs/environment.ts`'s `ModelSelection` and to the run-override body `server/runs/api.ts`
 *  parses, by design: one shape, reused at every layer, matching the card's own instruction. */
export type ModelSelectionValue = { readonly connectionId: string; readonly model: string } | null;

export interface Catalog {
  readonly models: readonly CatalogModel[];
  readonly unavailable: readonly UnavailableConnection[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readCapabilities(value: unknown): CatalogModelCapabilities {
  const source = record(value);
  const flag = (key: string): boolean => source !== null && source[key] === true;
  return {
    streaming: flag('streaming'),
    toolUse: flag('toolUse'),
    thinking: flag('thinking'),
    promptCaching: flag('promptCaching'),
    structuredOutput: flag('structuredOutput'),
    contextManagement: flag('contextManagement'),
    webSearch: flag('webSearch'),
    tokenCounting: flag('tokenCounting'),
  };
}

interface DiscoveredRow {
  readonly connectionId: string;
  readonly providerModelId: string;
  readonly displayName: string;
  readonly capabilities: CatalogModelCapabilities;
}

/** `GET /api/models`'s body: `{ models: [...], unavailable?: [...] }` — `#129`'s own envelope. */
function readDiscoveryBody(body: unknown): {
  readonly rows: readonly DiscoveredRow[];
  readonly unavailable: readonly UnavailableConnection[];
} {
  const outer = record(body);
  const rawModels = outer === null ? null : outer['models'];
  if (!Array.isArray(rawModels)) throw new Error('The discovered-models response has no list.');
  const rows = rawModels.map((entry, index) => {
    const value = record(entry);
    if (
      value === null ||
      typeof value['connectionId'] !== 'string' ||
      typeof value['providerModelId'] !== 'string' ||
      typeof value['displayName'] !== 'string'
    ) {
      throw new Error(
        `Discovered model ${String(index)} has no connectionId, providerModelId, or displayName.`,
      );
    }
    return {
      connectionId: value['connectionId'],
      providerModelId: value['providerModelId'],
      displayName: value['displayName'],
      capabilities: readCapabilities(value['capabilities']),
    };
  });
  const rawUnavailable = outer === null ? undefined : outer['unavailable'];
  const unavailable: UnavailableConnection[] = [];
  if (Array.isArray(rawUnavailable)) {
    for (const entry of rawUnavailable) {
      const value = record(entry);
      if (
        value === null ||
        typeof value['connectionId'] !== 'string' ||
        typeof value['connectionName'] !== 'string' ||
        typeof value['reason'] !== 'string'
      ) {
        continue; // A malformed unavailable-entry is dropped, not fatal — it is already the "bad news" list.
      }
      unavailable.push({
        connectionId: value['connectionId'],
        connectionName: value['connectionName'],
        reason: value['reason'],
      });
    }
  }
  return { rows, unavailable };
}

/**
 * Join `GET /api/models` (discovered rows) with `GET /api/model-connections` (names and
 * readiness) into one selectable catalog, plus every connection that offers nothing to select and
 * why — a missing credential, an incomplete config, or a discovery call that itself failed.
 *
 * A discovered row whose `connectionId` names a connection `connectionsBody` does not carry is
 * dropped rather than shown with an invented name: `catalog.test.ts` proves this for the case a
 * connection was deleted between the two requests.
 */
export function readCatalog(discoveryBody: unknown, connectionsBody: unknown): Catalog {
  const { rows, unavailable: discoveryUnavailable } = readDiscoveryBody(discoveryBody);
  const connections = readModelConnections(connectionsBody);
  const byId = new Map(connections.map((connection) => [connection.id, connection]));

  const models: CatalogModel[] = [];
  for (const row of rows) {
    const connection = byId.get(row.connectionId);
    if (connection === undefined) continue;
    models.push({
      connectionId: row.connectionId,
      connectionName: connection.name,
      provider: connection.provider,
      providerModelId: row.providerModelId,
      displayName: row.displayName,
      capabilities: row.capabilities,
    });
  }

  const unavailable: UnavailableConnection[] = [...discoveryUnavailable];
  const named = new Set(unavailable.map((entry) => entry.connectionId));
  for (const connection of connections) {
    if (connection.ready || named.has(connection.id)) continue;
    unavailable.push({
      connectionId: connection.id,
      connectionName: connection.name,
      reason: connectionStatus(connection).text,
    });
  }

  return { models, unavailable };
}

export function sameSelection(a: ModelSelectionValue, b: ModelSelectionValue): boolean {
  if (a === null || b === null) return a === b;
  return a.connectionId === b.connectionId && a.model === b.model;
}

export function findCatalogEntry(
  catalog: readonly CatalogModel[],
  value: ModelSelectionValue,
): CatalogModel | undefined {
  if (value === null) return undefined;
  return catalog.find(
    (entry) => entry.connectionId === value.connectionId && entry.providerModelId === value.model,
  );
}

/** "Anthropic / claude-sonnet-4-5" — the resolved half of the card's own inheritance-line example. */
export function formatResolvedModel(entry: CatalogModel): string {
  return `${providerLabel(entry.provider)} / ${entry.displayName}`;
}

/**
 * One line naming where a value comes from and what it resolves to — the card's own example,
 * `"Project default → Anthropic / claude-sonnet-4-5"`. A selection whose connection or model the
 * catalog no longer carries still names the raw ids rather than going blank: a stale selection is
 * shown as stale, not hidden.
 */
export function describeInheritance(
  sourceLabel: string,
  value: ModelSelectionValue,
  catalog: readonly CatalogModel[],
): string {
  if (value === null) return `${sourceLabel} → not set`;
  const entry = findCatalogEntry(catalog, value);
  const resolved =
    entry === undefined
      ? `${value.model} (connection ${value.connectionId} is no longer available)`
      : formatResolvedModel(entry);
  return `${sourceLabel} → ${resolved}`;
}

/**
 * `docs/spec.md` §12's own warning, shown only when the *selected catalog entry's own reported*
 * `capabilities.promptCaching` is `false` — never guessed from the provider id. `#130`'s "no
 * capability badges beyond what the catalog reports" applies to this string too: it is real
 * discovery data or it is not shown.
 */
export const PROMPT_CACHING_WARNING =
  '⚠ This model does not fully support Claude prompt caching.\nThe agent can still run, but behavior may differ.';
