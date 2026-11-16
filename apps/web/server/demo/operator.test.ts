import { describe, expect, it } from 'vitest';

import { operatorRefusal } from './operator';

const TOKEN = 't'.repeat(40);

const request = (authorization?: string): Request =>
  new Request('https://platform.example.test/api/demo/templates', {
    headers: authorization === undefined ? {} : { authorization },
  });

describe('operatorRefusal', () => {
  it('answers 404 while the deployment has no operator token, whatever is sent', () => {
    expect(operatorRefusal(request(`Bearer ${TOKEN}`), null)?.status).toBe(404);
    expect(operatorRefusal(request(), null)?.status).toBe(404);
  });

  it('answers 401 to a missing, wrong or differently shaped token', () => {
    for (const header of [undefined, 'Bearer wrong', TOKEN, `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
      expect(operatorRefusal(request(header), TOKEN)?.status).toBe(401);
    }
  });

  it('lets the right bearer token through', () => {
    expect(operatorRefusal(request(`Bearer ${TOKEN}`), TOKEN)).toBeNull();
  });
});
