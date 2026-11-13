/**
 * The journeys' seed data, written through the app's own API as the signed-in person: the space
 * "Engineering" with a tree of three pages, a handbook and the two pages under it. Each journey
 * seeds a space of its own, so the runs in each language never share a page.
 *
 * This file imports nothing, so the app still reaches nothing outside itself.
 */

/** The three pages, in tree order: the first is the top, the others are under it. */
export const ENGINEERING_PAGES = [
  { title: 'Engineering handbook', text: 'How the engineering team works.' },
  { title: 'Onboarding', text: 'The first week of a new engineer.' },
  { title: 'Deploys', text: 'How a change reaches production.' },
];

/**
 * POST `body` to the app's `path` as the person, and the record it answered `201` with.
 *
 * @param {import('@playwright/test').APIRequestContext} request
 * @param {{ appUrl: string, token: string }} as
 * @param {string} path @param {Record<string, unknown>} body
 */
async function created(request, as, path, body) {
  const response = await request.post(`${as.appUrl}${path}`, {
    headers: { authorization: `Bearer ${as.token}` },
    data: body,
  });
  if (response.status() !== 201) {
    throw new Error(`POST ${path} answered ${String(response.status())}: ${await response.text()}`);
  }
  return response.json();
}

/**
 * Seed a space "Engineering" and its three pages: the space's id and the pages, top first.
 *
 * @param {import('@playwright/test').APIRequestContext} request
 * @param {{ appUrl: string, token: string }} as
 * @returns {Promise<{ spaceId: string, pages: { id: string, title: string }[] }>}
 */
export async function seedEngineering(request, as) {
  const space = await created(request, as, '/api/spaces', { name: 'Engineering' });
  const [top, ...under] = ENGINEERING_PAGES;
  const page = (seed, parent, position) =>
    created(request, as, '/api/pages', {
      space: space.id,
      ...(parent === undefined ? {} : { parent }),
      position,
      title: seed.title,
      blocks: [{ type: 'paragraph', text: seed.text }],
    });
  const handbook = await page(top, undefined, 1);
  const children = [];
  for (const [at, seed] of under.entries()) children.push(await page(seed, handbook.id, at + 1));
  return { spaceId: space.id, pages: [handbook, ...children] };
}
