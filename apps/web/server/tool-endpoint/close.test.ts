import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeEndpointToolSandbox } from './close';
import { installToolEndpoint, resetToolEndpoint, type ToolEndpointEnvironment } from './env';

const SECRET = 'sk-live-do-not-print-0123456789';

function install(closeSandbox: ToolEndpointEnvironment['closeSandbox']): void {
  installToolEndpoint({ closeSandbox } as ToolEndpointEnvironment);
}

class ManagerDown extends Error {
  override name = 'ManagerDown';
}

afterEach(() => {
  resetToolEndpoint();
  vi.restoreAllMocks();
});

describe('closeEndpointToolSandbox', () => {
  it('does nothing when the tool endpoint is not installed', async () => {
    await expect(closeEndpointToolSandbox('w', 'c')).resolves.toBeUndefined();
  });

  it("closes the client's sandbox in its workspace", async () => {
    const close = vi.fn(() => Promise.resolve());
    install(close);
    await closeEndpointToolSandbox('workspace-one', 'client-one');
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith('workspace-one', 'client-one');
  });

  it('survives a failing close and logs only the error class', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    install(() => Promise.reject(new ManagerDown(`could not reach http://runner with ${SECRET}`)));
    await expect(closeEndpointToolSandbox('w', 'c')).resolves.toBeUndefined();
    const output = JSON.stringify(log.mock.calls);
    expect(output).toContain('ManagerDown');
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain('http://runner');
  });
});
