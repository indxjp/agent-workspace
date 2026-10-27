import { captureLog } from '../telemetry/capture-log';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { closeEndpointToolSandbox } from './close';
import type { ToolEndpointEnvironment } from './env';

const SECRET = 'sk-live-do-not-print-0123456789';

function install(closeSandbox: ToolEndpointEnvironment['closeSandbox']): void {
  installTestDomains({
    toolEndpoint: { kind: 'serving', environment: { closeSandbox } as ToolEndpointEnvironment },
  });
}

class ManagerDown extends Error {
  override name = 'ManagerDown';
}

afterEach(() => {
  clearApplicationContext();
  vi.restoreAllMocks();
});

describe('closeEndpointToolSandbox', () => {
  it('does nothing when the tool endpoint is not installed', async () => {
    await expect(closeEndpointToolSandbox('w', 'c')).resolves.toBeUndefined();
  });

  it('does nothing while the tool endpoint is disabled', async () => {
    const capture = captureLog();
    installTestDomains({ toolEndpoint: { kind: 'disabled' } });
    await expect(closeEndpointToolSandbox('w', 'c')).resolves.toBeUndefined();
    expect(capture.text()).toBe('');
  });

  it("closes the client's sandbox in its workspace", async () => {
    const close = vi.fn(() => Promise.resolve());
    install(close);
    await closeEndpointToolSandbox('workspace-one', 'client-one');
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith('workspace-one', 'client-one');
  });

  it('survives a failing close and logs only the error class', async () => {
    const capture = captureLog();
    install(() => Promise.reject(new ManagerDown(`could not reach http://runner with ${SECRET}`)));
    await expect(closeEndpointToolSandbox('w', 'c')).resolves.toBeUndefined();
    const output = capture.text();
    expect(output).toContain('ManagerDown');
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain('http://runner');
  });
});
