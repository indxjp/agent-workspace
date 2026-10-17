/**
 * Turning a resolved `ts.Type` into an MDX property table (or, for a union, a list of members; or,
 * for a type too large to expand, its type string) — shared by the contracts renderer, the SDK
 * option-interface tables, and `ClientOptions`/`RequestOptions`/`ClientAuth` on the client page.
 */
import ts from 'typescript';

import { TYPE_FORMAT } from './ts-nodes.mjs';

import { tsDocOf } from './ts-doc.mjs';
import { table, typeCell, mdxTableCell } from './mdx.mjs';

const MAX_EXPANDABLE_PROPERTIES = 40;

/**
 * An exported type alias or interface of the module being rendered, so a property whose type is
 * that alias is printed by the name a consumer imports (`readonly RunResource[]`) rather than as
 * the expanded shape behind a `z.infer`. `declaration` is the alias's or interface's own node, so
 * a match is made by identity first (structural identity is not naming identity: two exports with
 * the same shape are still two names).
 * @typedef {{ readonly name: string, readonly type: ts.Type, readonly declaration: ts.Declaration }} NamedType
 */

/** @param {ts.Type} type */
function isObjectType(type) {
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

/**
 * Whether `type` *is* the candidate — the checker's same type object, or a type declared by the
 * candidate's alias or interface node — as opposed to merely having the same shape.
 * @param {ts.Type} type @param {NamedType} candidate
 */
function isDeclaredBy(type, candidate) {
  if (type === candidate.type) return true;
  const declarations = [
    ...(type.aliasSymbol?.declarations ?? []),
    ...(type.symbol?.declarations ?? []),
  ];
  return declarations.includes(candidate.declaration);
}

/**
 * The candidate `type` is structurally identical to, when there is exactly one — two candidates of
 * the same shape are two names, and picking either would be a guess.
 * @param {ts.TypeChecker} checker @param {ts.Type} type @param {readonly NamedType[]} aliases
 */
function soleStructuralMatch(checker, type, aliases) {
  const matches = aliases.filter(
    (candidate) =>
      isObjectType(candidate.type) &&
      checker.isTypeAssignableTo(type, candidate.type) &&
      checker.isTypeAssignableTo(candidate.type, type),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * A type printed by the name of the exported alias that declares it — or, failing that, of the
 * one exported alias with exactly its shape — recursing through unions and (readonly) arrays;
 * the checker's own text otherwise, including when two exports share the shape and neither
 * declares the type (expanded rather than guessed).
 * @param {ts.TypeChecker} checker @param {ts.Type} type @param {ts.Node} contextNode
 * @param {readonly NamedType[]} aliases
 * @returns {string}
 */
export function namedTypeText(checker, type, contextNode, aliases) {
  if (type.isUnion()) {
    return type.types
      .map((member) => namedTypeText(checker, member, contextNode, aliases))
      .join(' | ');
  }
  if (isObjectType(type)) {
    const alias =
      aliases.find((candidate) => isDeclaredBy(type, candidate)) ??
      soleStructuralMatch(checker, type, aliases);
    if (alias !== undefined) return alias.name;
    if (checker.isArrayType(type)) {
      const element = checker.getTypeArguments(/** @type {ts.TypeReference} */ (type))[0];
      if (element !== undefined) {
        const isReadonly = type.symbol.getName() === 'ReadonlyArray';
        const inner = namedTypeText(checker, element, contextNode, aliases);
        const wrapped = element.isUnion() ? `(${inner})` : inner;
        return `${isReadonly ? 'readonly ' : ''}${wrapped}[]`;
      }
    }
  }
  return checker.typeToString(type, contextNode, TYPE_FORMAT);
}

/**
 * The TSDoc of a property symbol, from its own declaration when it has one in this source.
 * @param {ts.Symbol} symbol
 */
function propertyDoc(symbol) {
  const declaration = symbol.declarations?.[0];
  return declaration === undefined ? '' : tsDocOf(declaration);
}

/**
 * The name a property row shows. A property keyed by a `unique symbol` has a checker-internal
 * escaped name (`__@NAME@<id>`) whose numeric id differs between programs, so it is rendered as
 * its computed key (`[NAME]`) instead; that keeps the page byte-stable across renders.
 * @param {ts.TypeChecker} checker @param {ts.Symbol} symbol
 */
function propertyDisplayName(checker, symbol) {
  const escaped = String(symbol.escapedName);
  if (!escaped.startsWith('__@')) return symbol.name;
  const shown = checker.symbolToString(symbol);
  return shown.startsWith('[') ? shown : `[${shown}]`;
}

/**
 * Whether the checker considers a property symbol optional (`SymbolFlags.Optional`).
 * @param {ts.Symbol} symbol
 */
function isOptionalProperty(symbol) {
  return (symbol.flags & ts.SymbolFlags.Optional) !== 0;
}

/**
 * @param {ts.TypeChecker} checker @param {ts.Type} type @param {ts.Node} contextNode
 * @param {boolean} includeDoc whether to add a "Description" column (from a doc override map, or
 *   the property's own declaration TSDoc when there is no override).
 * @param {ReadonlyMap<string, string>} [docOverrides] property name → TSDoc, e.g. from walking a
 *   `z.object({...})` literal.
 * @param {readonly NamedType[]} [aliases]
 */
function objectPropertyRows(checker, type, contextNode, includeDoc, docOverrides, aliases = []) {
  return type.getProperties().map((symbol) => {
    const propertyType = checker.getTypeOfSymbol(symbol);
    const typeText = namedTypeText(checker, propertyType, contextNode, aliases);
    const required = isOptionalProperty(symbol) ? 'No' : 'Yes';
    const cells = [`\`${propertyDisplayName(checker, symbol)}\``, typeCell(typeText), required];
    if (includeDoc) {
      const doc = docOverrides?.get(symbol.name) ?? propertyDoc(symbol);
      cells.push(mdxTableCell(doc));
    }
    return cells;
  });
}

/**
 * Render `type` as a property table when it is a plain object shape, as a bullet list of members
 * when it is a union, or as a single type string when it has too many properties to expand.
 * @param {ts.TypeChecker} checker @param {ts.Type} type @param {ts.Node} contextNode
 * @param {ReadonlyMap<string, string>} [docOverrides] @param {readonly NamedType[]} [aliases]
 */
export function renderTypeSection(checker, type, contextNode, docOverrides, aliases = []) {
  if (type.isUnion() && type.types.length > 1) {
    const members = type.types.map(
      (member) => `- \`${namedTypeText(checker, member, contextNode, aliases)}\``,
    );
    return members.join('\n');
  }
  // A primitive (string, number, a string-literal type, …) reports the String/Number prototype's
  // members through `getProperties()`; only a genuine object type is worth expanding as a table.
  const properties = isObjectType(type) ? type.getProperties() : [];
  if (properties.length === 0) {
    return `\`${checker.typeToString(type, contextNode, TYPE_FORMAT)}\``;
  }
  if (properties.length > MAX_EXPANDABLE_PROPERTIES) {
    return `Too large to expand (${String(properties.length)} properties): \`${checker.typeToString(type, contextNode, TYPE_FORMAT)}\``;
  }
  const rows = objectPropertyRows(checker, type, contextNode, true, docOverrides, aliases);
  return table(['Name', 'Type', 'Required', 'Description'], rows);
}
