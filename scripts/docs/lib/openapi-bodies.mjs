/**
 * Zod schema → `components.schemas`, and route bodies → OpenAPI media-type maps, for
 * `generate-openapi.mjs`.
 */

/**
 * @typedef {import('@indx-workspace/contracts/routes').ApiSchemaName} ApiSchemaName
 * @typedef {import('@indx-workspace/contracts/routes').ApiBody} ApiBody
 * @typedef {'input' | 'output'} Direction
 * @typedef {(schemaName: ApiSchemaName, io: Direction) => string} ComponentResolver
 */

const OCTET_STREAM = 'application/octet-stream';

const UNDESCRIBED_NOTE =
  'Not yet described by a contract schema; the route catalogue lists it as `json-undescribed` ' +
  '(packages/contracts/src/routes.ts).';

const EVENT_STREAM_NOTE =
  'A stream of Server-Sent Events. Each frame names its kind in `event:`; its `data:` ' +
  'is one JSON value matching one of `x-agent-workspace-frames`. Durable frames carry ' +
  '`id:`; resume by sending it back as `Last-Event-ID`.';

/** A `$ref` to a named component schema. */
export const ref = (/** @type {string} */ name) => ({ $ref: `#/components/schemas/${name}` });

/**
 * `Schema`-suffixed export name → component name: `MeResponseSchema` → `MeResponse`.
 * @param {string} schemaName
 */
function componentName(schemaName) {
  return schemaName.replace(/Schema$/u, '');
}

/**
 * Replace every local JSON-pointer `$ref` in `node` through `rewrite`. Zod emits `#/$defs/…` (and
 * `#` for a self-reference) relative to the schema it converted; inside an OpenAPI document those
 * pointers would resolve against the document root, so they are rewritten to components.
 * @param {unknown} node @param {(pointer: string) => string} rewrite
 * @returns {unknown}
 */
function rewriteRefs(node, rewrite) {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, rewrite));
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) =>
        key === '$ref' && typeof value === 'string'
          ? [key, rewrite(value)]
          : [key, rewriteRefs(value, rewrite)],
      ),
    );
  }
  return node;
}

/**
 * Convert one schema into `components.schemas` entries: the schema itself under `name`, and each
 * of its `$defs` hoisted as `name_def`.
 * @param {(typeof import('@indx-workspace/contracts/routes').API_SCHEMAS)[ApiSchemaName]} schema
 * @param {string} name @param {Direction} io
 * @returns {Record<string, unknown>}
 */
function toComponents(schema, name, io) {
  const converted = schema.toJSONSchema({
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  });
  const { $defs = {}, ...root } = converted;
  delete root.$schema;
  const rewrite = (/** @type {string} */ pointer) => {
    if (pointer === '#') return `#/components/schemas/${name}`;
    const match = /^#\/\$defs\/(.+)$/u.exec(pointer);
    if (match === null) throw new Error(`${name}: unexpected $ref ${pointer}`);
    return `#/components/schemas/${name}_${match[1]}`;
  };
  const out = { [name]: rewriteRefs(root, rewrite) };
  for (const [defName, def] of Object.entries($defs)) {
    out[`${name}_${defName}`] = rewriteRefs(def, rewrite);
  }
  return out;
}

/**
 * The `components.schemas` map being filled, and the resolver that fills it: a schema is converted
 * on first use and its component name returned.
 * @param {Record<string, (typeof import('@indx-workspace/contracts/routes').API_SCHEMAS)[ApiSchemaName]>} apiSchemas
 * @returns {{ schemas: Record<string, unknown>, component: ComponentResolver }}
 */
export function createSchemaRegistry(apiSchemas) {
  /** @type {Record<string, unknown>} */
  const schemas = {};
  /** @type {ComponentResolver} */
  const component = (schemaName, io) => {
    const schema = apiSchemas[schemaName];
    if (schema === undefined) throw new Error(`unknown schema ${schemaName}`);
    const outputName = componentName(schemaName);
    if (!(outputName in schemas))
      Object.assign(schemas, toComponents(schema, outputName, 'output'));
    if (io === 'output') return outputName;
    const inputName = `${outputName}Input`;
    if (inputName in schemas) return inputName;
    const input = toComponents(schema, inputName, 'input');
    const asOutput = toComponents(schema, outputName, 'output');
    // One component when both directions agree, which is the common case.
    if (JSON.stringify(input[inputName]) === JSON.stringify(asOutput[outputName]))
      return outputName;
    Object.assign(schemas, input);
    return inputName;
  };
  return { schemas, component };
}

/**
 * @param {Extract<ApiBody, { kind: 'json' }>} body @param {Direction} io
 * @param {ComponentResolver} component
 */
function jsonContent(body, io, component) {
  const names = body.schemas.map((name) => component(name, io));
  const [only, ...more] = names;
  const schema =
    only !== undefined && more.length === 0 ? ref(only) : { oneOf: names.map((name) => ref(name)) };
  return { 'application/json': { schema } };
}

/** @param {Extract<ApiBody, { kind: 'multipart' }>} body */
function multipartContent(body) {
  /** @type {Record<string, unknown>} */
  const properties = {};
  /** @type {Record<string, unknown>} */
  const encoding = {};
  for (const part of body.parts) {
    const isText = part.type === 'text';
    const value = isText ? { type: 'string' } : { contentMediaType: OCTET_STREAM, type: 'string' };
    properties[part.name] =
      part.repeated === true
        ? { description: part.description, items: value, minItems: 1, type: 'array' }
        : { ...value, description: part.description };
    encoding[part.name] = { contentType: isText ? 'text/plain' : OCTET_STREAM };
  }
  return {
    'multipart/form-data': {
      encoding,
      schema: { properties, required: body.parts.map((part) => part.name), type: 'object' },
    },
  };
}

/**
 * The media-type map of one request or response body.
 * @param {ApiBody} body @param {Direction} io @param {ComponentResolver} component
 * @returns {Record<string, Record<string, unknown>>}
 */
export function bodyContent(body, io, component) {
  switch (body.kind) {
    case 'json':
      return jsonContent(body, io, component);
    case 'json-undescribed':
      return { 'application/json': { schema: { description: UNDESCRIBED_NOTE } } };
    case 'binary':
      return {
        [OCTET_STREAM]: { schema: { contentMediaType: OCTET_STREAM, type: 'string' } },
      };
    case 'event-stream':
      return {
        'text/event-stream': {
          schema: { description: EVENT_STREAM_NOTE, type: 'string' },
          'x-agent-workspace-frames': body.frames.map((name) => ref(component(name, 'output'))),
        },
      };
    case 'multipart':
      return multipartContent(body);
    default:
      throw new Error(`unexpected body kind ${body.kind}`);
  }
}
