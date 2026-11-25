import { builtinSkill, defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

// Drafting (DR), the rebuild of the gallery's quotation agent: it finds the part's past orders and
// the rate table in the ERP exports under `quotation/` with `search_files`, computes the price with
// the `quotation` skill's script (the table reader of office-reader, ADR-0173), and drafts the quote
// in its answer. Its one write is the ERP registration, `create_quote` on the `quotation-erp`
// connector, which always waits for a person's approval. It holds no write grant, so the reads and
// the script run unasked (ADR-0167 D5). The typed quote is the `outputSchema` a run asks for.
export default defineAgent({
  name: 'quotation',
  instructions: { file: './quotation.md' },
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files', 'mcp__agent-workspace__run_skill_script'],
    requireApproval: ['mcp__quotation-erp__create_quote'],
  },
  permissions: { readFiles: true, runCommands: true },
  tools: [mcp('quotation-erp')],
  skills: [builtinSkill('office-reader'), skill('quotation')],
  files: [files('quotation', 'read')],
});
