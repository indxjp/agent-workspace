/**
 * The wiki's parts (issue #1521): a person opens a page from the tree by keyboard, edits and saves
 * it; "Rewrite with Writer" opens the agent panel with a prompt naming the page, and the agent's
 * change lands as a new revision with an agent badge and a link to its run; restoring the first
 * revision brings its text back as the newest one.
 *
 * Against the desk fixture (`playwright.app-kit.config.mjs`): `definePages` on the in-memory page
 * store, the page routes, and a scripted Agent Workspace whose writer run calls `page_update` as
 * the person through the agent, with its run id and the prompt's `expectedRevisionId`.
 */
import { expect, test } from '@playwright/test';

import { expectBasicAccessibility } from '../harness.mjs';

const FIRST_TEXT = 'When the printer jams, open the tray and pull out the paper. Then ask Net.';

test('a person edits a page, a writer agent rewrites it as a revision, and restoring the first brings it back', async ({
  page,
}) => {
  await page.goto('/signin');
  await page.goto('/wiki');
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge base' })).toBeVisible();
  const tree = page.getByRole('tree', { name: 'Pages' });
  await expect(tree.getByRole('treeitem', { name: 'Handbook' })).toBeVisible();
  await expectBasicAccessibility(page);

  // The tree by keyboard: Right opens Handbook, Down moves to the page under it, Enter opens it.
  await tree.getByRole('treeitem', { name: 'Handbook' }).focus();
  await page.keyboard.press('ArrowRight');
  const jams = tree.getByRole('treeitem', { name: 'Printer jams' });
  await expect(jams).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'Handbook' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await page.keyboard.press('ArrowDown');
  await expect(jams).toBeFocused();
  await expect(jams).toHaveAttribute('aria-level', '2');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Printer jams' })).toBeVisible();
  await expect(jams).toHaveAttribute('aria-selected', 'true');

  // The person edits: Enter at the end of the block starts a new one, then Save.
  const first = page.getByLabel('Block 1 text (Paragraph)');
  await expect(first).toHaveValue(FIRST_TEXT);
  await first.focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const second = page.getByLabel('Block 2 text (Paragraph)');
  await expect(second).toBeFocused();
  await page.keyboard.type('Wear gloves near the fuser.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await expectBasicAccessibility(page);

  await page.getByRole('button', { name: 'Show revisions' }).click();
  const drawer = page.getByRole('region', { name: 'Revisions' });
  const revisions = drawer.locator('.aw-app-page-revision');
  await expect(revisions).toHaveCount(2);
  await expect(revisions.first()).toContainText('Saved by Desk person');
  await expectBasicAccessibility(page);

  // The agent's rewrite: the prompt names the page, the tool and the revision; the person sends it.
  await page.getByRole('button', { name: 'Rewrite with Writer' }).click();
  const prompt = page.getByLabel('What should the agent do with this record?');
  await expect(prompt).toHaveValue(/page_update/u);
  await expect(prompt).toHaveValue(/"expectedRevisionId":"[0-9a-f-]{36}"/u);
  await expect(page.getByLabel('Agent', { exact: true })).toHaveValue('writer');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  await expect(page.getByText('I rewrote Printer jams as steps, in a new revision.')).toBeVisible();

  await expect(page.getByLabel('Block 1 text (Heading 2)')).toHaveValue('Clearing a paper jam');
  await expect(revisions).toHaveCount(3);
  const rewritten = revisions.first();
  await expect(rewritten.getByText('Agent', { exact: true })).toBeVisible();
  await expect(rewritten).toContainText('Saved by Writer');
  await expect(rewritten.getByRole('link', { name: /^Open run [0-9a-f-]{36}$/u })).toHaveAttribute(
    'href',
    /^https:\/\/aw\.test\/runs\?run=[0-9a-f-]{36}$/u,
  );
  // Compared: the revision's preview shows the agent's body beside the editor.
  await rewritten.getByText('Preview', { exact: true }).click();
  await expect(rewritten.getByRole('heading', { name: 'Clearing a paper jam' })).toBeVisible();
  await expectBasicAccessibility(page);

  // Restore the first revision: its text is back, as the newest revision.
  await revisions
    .last()
    .getByRole('button', { name: /^Restore the revision of / })
    .click();
  await expect(page.getByText('The revision is restored as the newest one.')).toBeVisible();
  await expect(page.getByLabel('Block 1 text (Paragraph)')).toHaveValue(FIRST_TEXT);
  await expect(page.getByLabel('Block 2 text (Paragraph)')).toHaveCount(0);
  await expect(revisions).toHaveCount(4);
  await expect(revisions.first().getByText('Current', { exact: true })).toBeVisible();
  await expectBasicAccessibility(page);
});

test('the wiki speaks Japanese', async ({ page }) => {
  await page.goto('/signin?lang=ja');
  await page.goto('/wiki?lang=ja');
  await expect(page.getByRole('heading', { level: 1, name: 'ナレッジベース' })).toBeVisible();
  const tree = page.getByRole('tree', { name: 'ページ' });
  await tree.getByRole('treeitem', { name: 'Handbook' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Handbook' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ライターで書き換え' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新しいページに要約' })).toBeVisible();
  await expect(page.getByLabel('ブロック 1 の本文（段落）')).toBeVisible();
  await expectBasicAccessibility(page);
});
