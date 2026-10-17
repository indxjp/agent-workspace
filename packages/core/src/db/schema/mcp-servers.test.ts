/**
 * `parseMcpArgs` is the only runtime assertion the `mcp_servers.args` convention has: the column
 * is `jsonb` with a `$type<McpArgs>()` hint Drizzle does not enforce, and it carries no
 * `jsonb_typeof(args) = 'array'` CHECK. Verification round 2 found this function exported,
 * uncalled and untested, while the branch's prose described it as the control every read goes
 * through. The prose is withdrawn; these tests are here so the function at least does what its
 * own doc comment says, before a reader in a later wave relies on it.
 *
 * They do NOT claim anything about who calls it. That is a fact about the repository, not about
 * this module, and it is declared on the pull request instead.
 */
import { describe, expect, it } from 'vitest';

import { McpArgs, parseMcpArgs } from './mcp-servers.js';

describe('parseMcpArgs', () => {
  it("accepts §8's own example and returns it", () => {
    const args = ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'];
    expect(parseMcpArgs(args)).toEqual(args);
  });

  it('accepts an empty argument list', () => {
    expect(parseMcpArgs([])).toEqual([]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '-y'],
    ['an object', { '0': '-y' }],
    ['a list with a number in it', ['-y', 1]],
    ['a list with a nested list in it', ['-y', ['--flag']]],
    ['a list with null in it', ['-y', null]],
  ])('rejects %s', (_label, value) => {
    expect(() => parseMcpArgs(value)).toThrow();
  });

  it("is the same schema the column's $type is derived from", () => {
    // If `McpArgs` were ever widened without widening the parse, the two would disagree and the
    // compile-time hint would stop describing what the parse accepts.
    expect(McpArgs.safeParse(['-y']).success).toBe(true);
    expect(McpArgs.safeParse(['-y', 1]).success).toBe(false);
  });
});
