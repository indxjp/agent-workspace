import { defineTool, z } from '@indx-workspace/sdk/define';

// A code tool: `aw dev` runs `run` on your machine. `run` is relative to the project root, not to
// this file. A deployment runs it only where its operator turned on the tool sandbox; `aw push`
// refuses to push it to one that did not.
export default defineTool({
  name: 'delivery_estimate',
  description: 'Say how many days remain until an order is delivered, and whether it is late',
  input: z.object({ orderNumber: z.string().describe('The order number, like A-1042') }),
  run: './tools/delivery-estimate.run.ts',
});
