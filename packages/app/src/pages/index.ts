/**
 * The page resource kind (F-6, issue #1520): `definePages`, and the block model its body is kept
 * in, with the one conversion between blocks and markdown. Pure.
 */
export {
  blocksPlainText,
  blocksToMarkdown,
  markdownToBlocks,
  PAGE_BLOCK_TYPES,
  pageBlockIssues,
  type PageBlockType,
} from './blocks.js';
export {
  definePages,
  isPageResource,
  PAGE_TITLE_MAX,
  type DefinedPages,
  type PageBaseFields,
  type PageFieldName,
  type PagesInput,
  type PageSpaceFields,
} from './define-pages.js';
