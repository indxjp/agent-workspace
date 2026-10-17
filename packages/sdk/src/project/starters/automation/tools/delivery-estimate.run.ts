import type { ToolRun } from '@indx-workspace/sdk/define';

import type deliveryEstimate from './delivery-estimate.ts';

/** Where the orders API is; the starter's fake API by default (`node fake-api/server.ts`). */
const ORDERS_URL = process.env['ORDERS_URL'] ?? 'http://127.0.0.1:4010';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Order {
  readonly expectedDelivery: string;
}

const run: ToolRun<typeof deliveryEstimate> = async ({ orderNumber }, { signal }) => {
  const response = await fetch(`${ORDERS_URL}/orders/${encodeURIComponent(orderNumber)}`, {
    signal,
  });
  if (!response.ok) return { error: `order ${orderNumber} not found` };
  const order = (await response.json()) as Order;
  const days = Math.ceil((Date.parse(order.expectedDelivery) - Date.now()) / DAY_MS);
  return { orderNumber, daysUntilDelivery: days, late: days < 0 };
};

export default run;
