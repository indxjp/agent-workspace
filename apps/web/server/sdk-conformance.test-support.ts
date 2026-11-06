/**
 * The seam between the control plane and `@indx-workspace/contracts`.
 *
 * The contracts package states what crosses the wire; the application's serializers are what
 * actually cross it. This gate holds the two together from the application's side: every value
 * a real serializer renders must satisfy the schema the SDK validates against, and every
 * vocabulary the server restates (run statuses, providers, accounting states, reserved event
 * names) must equal the one the contracts publish. It fails when either side drifts, which is the
 * point — `docs/sdk/03-sdk-design.md` makes this test the condition for consuming a domain
 * through the SDK rather than through the application's own parsers.
 *
 * It lives in the application rather than in a package because it is the application's promise:
 * `packages/*` may not import an application, and these serializers resolve under the web app's
 * own compiler settings.
 */

export const WORKSPACE = '44444444-4444-4444-8444-444444444444';
export const AGENT = '11111111-1111-4111-8111-111111111111';
export const SESSION = '55555555-5555-4555-8555-555555555555';
