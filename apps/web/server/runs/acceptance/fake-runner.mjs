// A stand-in for the §14.3 runtime container, for the W1-CP-04 acceptance run only.
//
// It implements exactly the two endpoints the probe needs — `GET /healthz` and `POST /run`,
// which "start[s] a run, respond[s] with an SSE stream of SDK events" — and nothing else. The
// real one is W1-RN-02's `apps/runner`, which does not exist on this branch; this file exists so
// the control plane's relay can be exercised end to end rather than mocked.
//
// The event schedule is chosen to make the acceptance criterion falsifiable:
//
//   * a DENSE phase (one event per second) so the reconnect half of the criterion has a tight,
//     unambiguous id sequence to be checked against;
//   * a SPARSE phase (one event every 30 s) that is longer than nginx's 60 s `proxy_read_timeout`
//     would tolerate on its own, so the stream only survives if the control plane's 15 s
//     keep-alive comments are really reaching the client.
//
// Usage: node fake-runner.mjs [port] [denseSeconds] [totalSeconds] [sparseIntervalSeconds] [nonce]
//
// The nonce is echoed by /healthz. The probe checks it, because a stale runtime left listening on
// this port by an earlier run answers /healthz perfectly well and then ends every stream
// immediately — which is exactly how one acceptance run in this task's development produced a
// green-looking "the run completed" in 0.1 seconds. A readiness check that cannot tell whose
// process answered is a check that passes because nothing failed.

/* global console, process, Buffer, setTimeout, clearTimeout */
// The root ESLint config declares no environment globals; scripts/*.mjs use the same mechanism.

import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 3112);
const denseSeconds = Number(process.argv[3] ?? 30);
const totalSeconds = Number(process.argv[4] ?? 640);
const sparseIntervalSeconds = Number(process.argv[5] ?? 30);
const nonce = process.argv[6] ?? 'no-nonce';

for (const [name, value] of [
  ['port', port],
  ['denseSeconds', denseSeconds],
  ['totalSeconds', totalSeconds],
  ['sparseIntervalSeconds', sparseIntervalSeconds],
]) {
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`fake-runner: ${name} must be a positive number, got ${String(value)}`);
    process.exit(2);
  }
}

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, nonce, totalSeconds, denseSeconds, sparseIntervalSeconds }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/run') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let request;
    try {
      request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"body is not JSON"}');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });

    const started = Date.now();
    let sequence = 0;
    // The engine-neutral `agent.*` vocabulary a real runner streams since ENG-03 (#302): the
    // relay is then relaying, and the control plane serving, what a real run produces. Nothing
    // here is the SDK — this process imports no Anthropic package (§42) — so `raw` carries a
    // plausible engine-shaped payload rather than a real one.
    const engine = 'claude-agent-sdk';
    res.write(
      frame('agent.session', {
        frame: 'agent.session',
        engine,
        raw: { type: 'system', subtype: 'init', runId: request.runId ?? null },
        engineSessionId: request.sessionId ?? 'fake-runner-session',
        model: null,
      }),
    );

    let timer;
    const stop = () => {
      clearTimeout(timer);
      if (!res.writableEnded) res.end();
    };
    // `res`, not `req`. An IncomingMessage emits 'close' as soon as its body has been fully
    // consumed, which is immediately — wiring the teardown to it ends every stream after the
    // first frame, and the probe then reports a ten-minute run that finished in 0.1 seconds.
    res.on('close', stop);

    const tick = () => {
      const elapsed = (Date.now() - started) / 1000;
      if (elapsed >= totalSeconds) {
        res.write(
          frame('agent.result', {
            frame: 'agent.result',
            engine,
            raw: { type: 'result', subtype: 'success', events: sequence },
            stopReason: 'end_turn',
            turns: sequence,
            engineCostUsd: null,
          }),
        );
        stop();
        return;
      }
      sequence += 1;
      res.write(
        frame('agent.message', {
          frame: 'agent.message',
          engine,
          raw: { type: 'assistant', seq: sequence, atSeconds: Number(elapsed.toFixed(3)) },
          messageId: `msg_${String(sequence)}`,
          role: 'assistant',
          blocks: [{ type: 'text', text: `tick ${String(sequence)} at ${elapsed.toFixed(3)}s` }],
        }),
      );
      const nextDelay = elapsed < denseSeconds ? 1000 : sparseIntervalSeconds * 1000;
      timer = setTimeout(tick, nextDelay);
    };
    timer = setTimeout(tick, 1000);
  });
});

server.on('error', (cause) => {
  console.error(`fake-runner: cannot listen on ${String(port)}: ${cause.message}`);
  process.exit(2);
});

server.listen(port, '127.0.0.1', () => {
  console.log(
    `fake-runner listening on http://127.0.0.1:${String(port)} ` +
      `(dense ${String(denseSeconds)}s, sparse every ${String(sparseIntervalSeconds)}s, total ${String(totalSeconds)}s)`,
  );
});
