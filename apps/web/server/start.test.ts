/**
 * Contract C2 (#441): `startWeb`'s options and posture check, and the build directory seam in
 * `next.config.ts`. Next.js itself is replaced by a spy; nothing here boots a server.
 */
import { log as webLogger } from './telemetry/logger';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readNextDistDir } from '../next.config';
import { closeHeldComposition, holdComposition } from './composition/held-composition';
import { registerOrStop } from './composition/stop-on-failed-start';
import { defineSlot } from './runtime-slot';
import { serveRequest, startWeb, StartWebOptionsError, type StartWebOptions } from './start';

const mocks = vi.hoisted(() => ({ createNext: vi.fn() }));

vi.mock('next/dist/server/next.js', () => ({ default: mocks.createNext }));

type FakeNext = {
  prepare: () => Promise<void>;
  getRequestHandler: () => () => Promise<void>;
  close: () => Promise<void>;
};

/** A Next stand-in that does nothing; `overrides` replaces any of its three methods. */
function fakeNext(overrides: Partial<FakeNext> = {}): FakeNext {
  return {
    prepare: () => Promise.resolve(),
    getRequestHandler: () => () => Promise.resolve(),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

const failPrepare = (): Promise<void> => Promise.reject(new Error(PREPARE_STOPPED));

/** A Next stand-in whose `prepare` fails, so `startWeb` stops right after `createNext`. */
const PREPARE_STOPPED = 'prepare stopped by the test';

function stopAtPrepare(): void {
  mocks.createNext.mockReturnValue(fakeNext({ prepare: failPrepare }));
}

const embeddedStart = defineSlot<unknown>('__agentWorkspaceEmbeddedStart__');

/** What Next's instrumentation does during a start: run `register()` through the stop guard. */
function registerSucceeds(): Promise<void> {
  return registerOrStop(() => Promise.resolve(undefined));
}

beforeEach(() => {
  mocks.createNext.mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  embeddedStart.clear();
  await closeHeldComposition();
});

describe('startWeb', () => {
  it('rejects an unknown option with a typed error before Next is created', async () => {
    const options = { dev: false, port: 4000 } as StartWebOptions;
    const failure = startWeb({ HOST: '127.0.0.1' }, options);
    await expect(failure).rejects.toBeInstanceOf(StartWebOptionsError);
    await expect(failure).rejects.toMatchObject({ code: 'invalid_start_options' });
    expect(mocks.createNext).not.toHaveBeenCalled();
  });

  it('rejects an empty dir with a typed error before Next is created', async () => {
    await expect(startWeb({}, { dir: '' })).rejects.toBeInstanceOf(StartWebOptionsError);
    expect(mocks.createNext).not.toHaveBeenCalled();
  });

  it.each(['', '   ', ' 127.0.0.1'])(
    'rejects a local posture on HOST=%j, which Node would not bind as loopback',
    async (host) => {
      await expect(
        startWeb({ NODE_ENV: 'production', AW_DEPLOYMENT_POSTURE: 'local', HOST: host }),
      ).rejects.toThrow('local posture needs a loopback HOST');
      expect(mocks.createNext).not.toHaveBeenCalled();
    },
  );

  it('binds 127.0.0.1, not every interface, when HOST is blank and no posture is set', async () => {
    stopAtPrepare();
    await expect(startWeb({ NODE_ENV: 'production', HOST: '' })).rejects.toThrow(PREPARE_STOPPED);
    expect(mocks.createNext).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: '127.0.0.1' }),
    );
  });
});

describe('startWeb refuses an unsafe bind or posture', () => {
  it('refuses a public bind when process.env holds a local posture the sites will read', async () => {
    vi.stubEnv('AW_DEPLOYMENT_POSTURE', 'local');
    vi.stubEnv('HOST', '127.0.0.1');
    await expect(startWeb({ NODE_ENV: 'production', HOST: '0.0.0.0' })).rejects.toThrow(
      'local posture needs a loopback HOST',
    );
    expect(mocks.createNext).not.toHaveBeenCalled();
  });

  it('rejects a local posture on a non-loopback HOST before Next is created', async () => {
    await expect(
      startWeb({ NODE_ENV: 'production', AW_DEPLOYMENT_POSTURE: 'local', HOST: '0.0.0.0' }),
    ).rejects.toThrow('local posture needs a loopback HOST');
    expect(mocks.createNext).not.toHaveBeenCalled();
  });

  it('rejects an invalid posture before Next is created', async () => {
    await expect(startWeb({ AW_DEPLOYMENT_POSTURE: 'prod' })).rejects.toThrow(
      /AW_DEPLOYMENT_POSTURE/u,
    );
    expect(mocks.createNext).not.toHaveBeenCalled();
  });

  it('rejects the dev issuer under the production posture before Next is created (ADR-0161 DI9)', async () => {
    await expect(
      startWeb({ NODE_ENV: 'production', OIDC_ISSUER_URL: 'http://127.0.0.1:3200' }),
    ).rejects.toThrow(/OIDC_ISSUER_URL must be an https: URL/u);
    expect(mocks.createNext).not.toHaveBeenCalled();
  });
});

/**
 * S1-25 (#510): the local runtime stops its embedded PostgreSQL right after closing the web server.
 * The composition's pools stayed open until the process exited, so every idle pooled client was
 * terminated with `57P01` on a normal Ctrl+C. `close` now releases them after Next has closed.
 */
describe('startWeb port', () => {
  it.each(['abc', '3000abc', '-1', '65536', '1e3', '0x10'])(
    'rejects PORT=%j before Next is created',
    async (port) => {
      await expect(
        startWeb({ NODE_ENV: 'production', HOST: '127.0.0.1', PORT: port }),
      ).rejects.toThrow('PORT must be a whole number');
      expect(mocks.createNext).not.toHaveBeenCalled();
    },
  );

  it('closes Next and the held composition when the listen fails', async () => {
    const events: string[] = [];
    mocks.createNext.mockReturnValue(
      fakeNext({
        prepare: registerSucceeds,
        close: () => {
          events.push('next.close');
          return Promise.resolve();
        },
      }),
    );
    holdComposition({
      close: () => {
        events.push('composition.close');
        return Promise.resolve();
      },
    });
    const occupant = createServer();
    await new Promise<void>((resolve) => occupant.listen(0, '127.0.0.1', resolve));
    const address = occupant.address();
    const taken = String(typeof address === 'object' && address !== null ? address.port : 0);
    await expect(
      startWeb({ NODE_ENV: 'production', HOST: '127.0.0.1', PORT: taken }),
    ).rejects.toThrow(/EADDRINUSE/u);
    expect(events).toStrictEqual(['next.close', 'composition.close']);
    await new Promise<void>((resolve) => occupant.close(() => resolve()));
  });
});

describe('startWeb close', () => {
  it('marks itself before Next registers, so a failed start rejects instead of exiting', async () => {
    let markedWhenCreated = false;
    mocks.createNext.mockImplementation(() => {
      markedWhenCreated = embeddedStart.current() !== null;
      return fakeNext({ prepare: failPrepare });
    });
    try {
      await expect(startWeb({ HOST: '127.0.0.1' })).rejects.toThrow(PREPARE_STOPPED);
      expect(markedWhenCreated).toBe(true);
    } finally {
      mocks.createNext.mockReset();
    }
  });

  it('waits for register() after prepare() and rejects with its failure, closing Next', async () => {
    const failure = new Error(
      'Start-up stopped on invalid settings. AW_TRUSTED_PROXY_HOPS is "two".',
    );
    const close = vi.fn(() => Promise.resolve());
    mocks.createNext.mockReturnValue(
      fakeNext({
        // In production Next resolves prepare() first and runs register() in the background.
        prepare: () => {
          setTimeout(
            () => void registerOrStop(() => Promise.reject(failure)).catch(() => undefined),
            5,
          );
          return Promise.resolve();
        },
        close,
      }),
    );
    try {
      await expect(startWeb({ HOST: '127.0.0.1', PORT: '0' })).rejects.toBe(failure);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      mocks.createNext.mockReset();
    }
  });
});

describe('startWeb close: register() failures', () => {
  it('reports both when register() failed and Next then fails to close', async () => {
    const failure = new Error('register failed');
    const closeFailure = new Error('next close failed');
    mocks.createNext.mockReturnValue(
      fakeNext({
        prepare: () => {
          void registerOrStop(() => Promise.reject(failure)).catch(() => undefined);
          return Promise.resolve();
        },
        close: () => Promise.reject(closeFailure),
      }),
    );
    try {
      const rejection = await startWeb({ HOST: '127.0.0.1', PORT: '0' }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(AggregateError);
      expect((rejection as AggregateError).errors).toEqual([failure, closeFailure]);
    } finally {
      mocks.createNext.mockReset();
    }
  });

  it('does not listen before register() has returned', async () => {
    let finishRegister = (): void => undefined;
    mocks.createNext.mockReturnValue(
      fakeNext({
        prepare: () => {
          finishRegister = () => void registerSucceeds();
          return Promise.resolve();
        },
      }),
    );
    try {
      let started = false;
      const web = startWeb({ NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0' }).then((w) => {
        started = true;
        return w;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(started).toBe(false);
      finishRegister();
      await (await web).close();
      expect(started).toBe(true);
    } finally {
      mocks.createNext.mockReset();
    }
  });
});

describe('startWeb close: the held composition', () => {
  it('closes the held composition after Next, and only once', async () => {
    const events: string[] = [];
    mocks.createNext.mockReturnValue(
      fakeNext({
        prepare: registerSucceeds,
        close: () => {
          events.push('next.close');
          return Promise.resolve();
        },
      }),
    );
    holdComposition({
      close: () => {
        events.push('composition.close');
        return Promise.resolve();
      },
    });

    const web = await startWeb({ NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0' });
    await web.close();
    expect(events).toStrictEqual(['next.close', 'composition.close']);

    // Released and forgotten: nothing is closed a second time.
    await closeHeldComposition();
    expect(events).toStrictEqual(['next.close', 'composition.close']);
  });

  it('still closes the held composition when Next fails to close', async () => {
    const events: string[] = [];
    mocks.createNext.mockReturnValue(
      fakeNext({
        prepare: registerSucceeds,
        close: () => Promise.reject(new Error('next close failed')),
      }),
    );
    holdComposition({
      close: () => {
        events.push('composition.close');
        return Promise.resolve();
      },
    });

    const web = await startWeb({ NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0' });
    await expect(web.close()).rejects.toThrow('next close failed');
    expect(events).toStrictEqual(['composition.close']);
  });
});

describe('serveRequest', () => {
  async function failWith(headersSent: boolean) {
    const response = { headersSent, statusCode: 200, end: vi.fn(), destroy: vi.fn() };
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const logged = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    process.on('unhandledRejection', record);
    try {
      serveRequest(() => Promise.reject(new Error('handler failed')))(
        {} as IncomingMessage,
        response as unknown as ServerResponse,
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(logged).toHaveBeenCalledWith('[web] request handler failed', {
        error: new Error('handler failed'),
      });
      expect(unhandled).toEqual([]);
    } finally {
      logged.mockRestore();
      process.off('unhandledRejection', record);
    }
    return response;
  }

  it('answers 500 when the handler rejects before the headers are sent', async () => {
    const response = await failWith(false);
    expect(response.statusCode).toBe(500);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.destroy).not.toHaveBeenCalled();
  });

  it('drops the connection when the handler rejects after the headers are sent', async () => {
    const response = await failWith(true);
    expect(response.destroy).toHaveBeenCalledTimes(1);
    expect(response.end).not.toHaveBeenCalled();
  });
});

describe('readNextDistDir', () => {
  it('defaults to .next when unset or blank', () => {
    expect(readNextDistDir({})).toBe('.next');
    expect(readNextDistDir({ AW_NEXT_DIST_DIR: '  ' })).toBe('.next');
  });

  it('uses a .next-prefixed directory name as given', () => {
    expect(readNextDistDir({ AW_NEXT_DIST_DIR: '.next-local' })).toBe('.next-local');
    expect(readNextDistDir({ AW_NEXT_DIST_DIR: ' .next.runtime ' })).toBe('.next.runtime');
  });

  // `next build` deletes distDir recursively first, so each of these would delete this app's own
  // sources (`.`, `app`, `server`, `public/`, ...) or escape it.
  it.each([
    '.',
    './',
    'app',
    'server',
    'public/',
    './public',
    'node_modules',
    'build/next',
    '.next/sub',
    '.next/../app',
    '/var/next',
    'C:\\next',
    '../next',
    'build/../../next',
    'build\\..\\next',
  ])('refuses %s and names the variable', (value) => {
    expect(() => readNextDistDir({ AW_NEXT_DIST_DIR: value })).toThrow(/AW_NEXT_DIST_DIR/u);
  });
});
