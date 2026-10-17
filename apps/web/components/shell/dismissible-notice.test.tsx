import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DismissibleNotice, isDismissed, rememberDismissal } from './dismissible-notice';

function stubStorage(storage: Pick<Storage, 'getItem' | 'setItem'>): void {
  vi.stubGlobal('window', { localStorage: storage });
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DismissibleNotice', () => {
  it('renders the notice and its dismiss button on the server', () => {
    const html = renderToStaticMarkup(
      <DismissibleNotice id="driver" version="driver=local" className="x" role="alert" testId="t">
        Watch out
      </DismissibleNotice>,
    );
    expect(html).toContain('Watch out');
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-testid="t"');
    expect(html).toContain('aria-label="Dismiss"');
  });
});

describe('dismissal storage', () => {
  it('remembers a dismissal for the same version under a namespaced key', () => {
    const storage = memoryStorage();
    stubStorage(storage);
    expect(isDismissed('driver', 'driver=local')).toBe(false);
    rememberDismissal('driver', 'driver=local');
    expect(storage.getItem('aw.notice.dismissed.driver')).toBe('driver=local');
    expect(isDismissed('driver', 'driver=local')).toBe(true);
  });

  it('shows the notice again when its version changes', () => {
    stubStorage(memoryStorage());
    rememberDismissal('driver', 'driver=local');
    expect(isDismissed('driver', 'driver=not configured')).toBe(false);
  });

  it('keeps showing the notice when storage throws', () => {
    const refuse = (): never => {
      throw new Error('SecurityError');
    };
    stubStorage({ getItem: refuse, setItem: refuse });
    expect(() => rememberDismissal('driver', 'driver=local')).not.toThrow();
    expect(isDismissed('driver', 'driver=local')).toBe(false);
  });
});
