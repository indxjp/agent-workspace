/* global console */
export function checkFirstConnection(first, check) {
  check(first.status === 200, 'the stream answers 200 through nginx');
  check(
    first.contentType === 'text/event-stream; charset=utf-8',
    'Content-Type survives the proxy',
    String(first.contentType),
  );
  check(
    first.contentEncoding === null,
    'nginx did not gzip the stream',
    `content-encoding=${String(first.contentEncoding)}`,
  );
  check(
    first.events.length > 0,
    'events arrived on the first connection',
    `${String(first.events.length)} events`,
  );
  check(
    first.maxGapMs < 20_000,
    'no proxy buffering: chunks arrive at the producer cadence on connection 1',
    `maxGapMs=${String(first.maxGapMs)}`,
  );
  const firstIds = first.events.map((e) => Number(e.id));
  check(
    firstIds.every((n, i) => i === 0 || n === firstIds[i - 1] + 1),
    'connection 1 ids are contiguous',
    `${String(firstIds[0])}..${String(firstIds.at(-1))}`,
  );

  return firstIds;
}

export function checkReconnect({ firstIds, second, resumeFrom, totalSeconds }, check) {
  const secondIds = second.events.map((e) => Number(e.id));
  check(second.status === 200, 'the reconnect answers 200');
  check(
    second.controlFrames.every((f) => f.event !== 'stream-reset'),
    'the resume cursor was servable — no stream-reset',
    JSON.stringify(second.controlFrames.map((f) => f.event)),
  );
  check(
    secondIds.length > 0 && secondIds[0] === Number(resumeFrom) + 1,
    'the reconnect replays from Last-Event-ID + 1',
    `resumed at ${String(resumeFrom)}, first replayed id ${String(secondIds[0])}`,
  );
  check(
    secondIds.every((n, i) => i === 0 || n === secondIds[i - 1] + 1),
    'connection 2 ids are contiguous',
    `${String(secondIds[0])}..${String(secondIds.at(-1))}`,
  );
  check(
    !secondIds.some((n) => firstIds.includes(n)),
    'the reconnect delivered no duplicate of what connection 1 already had',
  );
  check(
    second.comments > 0,
    'keep-alive comments reached the client through nginx',
    `${String(second.comments)} comments`,
  );
  check(
    second.maxGapMs < 40_000,
    'no gap approached nginx stock proxy_read_timeout (60s)',
    `maxGapMs=${String(second.maxGapMs)}`,
  );
  check(
    second.controlFrames.some((f) => f.event === 'done'),
    'the stream ended with a done frame rather than being cut',
    JSON.stringify(second.controlFrames.map((f) => f.event)),
  );
  // The exact control-frame set, not "no run-failed appeared". This run's run succeeds, so `done`
  // alone is the whole set; anything else — a `run-failed` this server should not have written, a
  // `stream-reset` the retention window should not have produced — fails here by not matching.
  check(
    second.controlFrames.length === 1 && second.controlFrames[0].event === 'done',
    'a run that completed ends with exactly one control frame, and it is done',
    JSON.stringify(second.controlFrames.map((f) => f.event)),
  );
  check(
    totalSeconds >= 600,
    'the stream ran for at least ten minutes',
    `${totalSeconds.toFixed(1)}s`,
  );

  return secondIds;
}

export function printProbeResult({
  proxyPath,
  first,
  second,
  firstIds,
  secondIds,
  resumeFrom,
  totalSeconds,
  nginxVersion,
  finalRun,
}) {
  const seq = [...firstIds, ...secondIds];
  console.log('');
  console.log(
    'RESULT ' +
      JSON.stringify({
        proxyPath,
        nginx: nginxVersion,
        durationS: Number(totalSeconds.toFixed(1)),
        connection1: {
          ttfbMs: first.ttfbMs,
          events: firstIds.length,
          lastId: firstIds.at(-1) ?? null,
          maxGapMs: first.maxGapMs,
          comments: first.comments,
          ce: first.contentEncoding,
          te: first.transferEncoding,
          xab: first.xAccelBuffering,
        },
        resumedFrom: Number(resumeFrom),
        connection2: {
          ttfbMs: second.ttfbMs,
          events: secondIds.length,
          firstId: secondIds[0] ?? null,
          lastId: secondIds.at(-1) ?? null,
          maxGapMs: second.maxGapMs,
          comments: second.comments,
          clean: second.clean,
          control: second.controlFrames.map((f) => f.event),
        },
        idsContiguousAcrossReconnect: seq.every((n, i) => i === 0 || n === seq[i - 1] + 1),
        totalEvents: seq.length,
        runStatus: finalRun.run.status,
      }),
  );
}
