/**
 * Live isolation conformance. `ISOLATION_LANE=docker|kind|kind-chart` picks the lane (`kind-chart` runs the kind cases against sandboxes
 * the deployed chart's runner manager allocates, #854); the suite creates real
 * sandboxes through that lane's driver and checks them from the inside. Every outcome is recorded
 * to `$ISOLATION_RESULTS` for `summary.mjs`: pass, fail, inconclusive, n/a or pending.
 *
 * A check that says "X cannot be reached" is only evidence if X can be reached from a workload with
 * no policy at all (`lane.control`), so those checks first read a positive control; a failed
 * control is `inconclusive`, which fails the lane, and never a pass. `open` is not that workload:
 * since ADR-0117 it is the public internet through the egress proxy, with the LAN and the cloud
 * metadata address refused.
 */
import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { createDockerLane, createKindLane, run } from './lane.mjs';

const laneName = process.env.ISOLATION_LANE;
if (laneName !== 'docker' && laneName !== 'kind' && laneName !== 'kind-chart') {
  throw new Error('ISOLATION_LANE must be "docker", "kind" or "kind-chart"; the isolation suite never skips a lane.');
}
const image = process.env.ISOLATION_IMAGE ?? 'aw-isolation-probe:ci';
const proxyImage = process.env.ISOLATION_PROXY_IMAGE ?? 'aw-egress-proxy:ci';
const internetUrl = process.env.ISOLATION_INTERNET_URL ?? 'http://connectivitycheck.gstatic.com/generate_204';
const resultsFile = process.env.ISOLATION_RESULTS ?? path.join(tmpdir(), `aw-isolation-${laneName}.json`);
const isChart = laneName === 'kind-chart';
const isKind = laneName === 'kind' || isChart;
// The chart's sandbox runs the real runtime server, which needs room beside the allocation test.
const MEMORY_MB = isChart ? 256 : 128;
// The docker driver charges the /workspace tmpfs to the memory cgroup, so its limit is memory + workspace.
const DISK_MB = 16;
const DOCKER_DISK = isKind ? {} : { diskMb: DISK_MB };
const LIMIT_MB = MEMORY_MB + (isKind ? 0 : DISK_MB);

const results = {};
function record(id, title, outcome, detail) {
  results[id] = { title, outcome, ...(detail === undefined ? {} : { detail }) };
  writeFileSync(resultsFile, `${JSON.stringify({ lane: laneName, results }, null, 2)}\n`);
}

class Inconclusive extends Error {}
const notApplicable = (detail) => ({ outcome: 'n/a', detail });

function check(id, title, body) {
  test(`${id}: ${title}`, async () => {
    try {
      const outcome = (await body()) ?? { outcome: 'pass' };
      record(id, title, outcome.outcome, outcome.detail);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record(id, title, error instanceof Inconclusive ? 'inconclusive' : 'fail', message);
      throw error;
    }
  });
}

const requiredEnv = (name) => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required for the kind-chart lane`);
  return value;
};
const lane = isKind
  ? await createKindLane({
      image,
      proxyImage,
      ...(isChart
        ? {
            manager: {
              url: requiredEnv('ISOLATION_MANAGER_URL'),
              token: requiredEnv('ISOLATION_MANAGER_TOKEN'),
              namespace: requiredEnv('ISOLATION_NAMESPACE'),
            },
          }
        : {}),
    })
  : await createDockerLane({ image, proxyImage });

async function withSandbox(label, options, body) {
  const sandbox = await lane.create(label, options);
  try {
    return await body(sandbox);
  } finally {
    await lane.destroy(sandbox).catch(() => {});
  }
}

const sh = (sandbox, script) => sandbox.exec(['sh', '-c', script]);
// `-Y off` ignores the proxy variables the driver sets, so this is the sandbox's own route out.
// The last failed probe's exit code and output, so a positive check that fails says why.
let lastFailure = '';
const succeeded = (result) => {
  if (result.code !== 0) lastFailure = `exit ${String(result.code)}: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 500)}`;
  return result.code === 0;
};
const reachable = async (sandbox, url, host) =>
  succeeded(await sandbox.exec(['wget', '-Y', 'off', '-q', '-T', '4', '-O', '/dev/null', ...(host === undefined ? [] : ['--header', `Host: ${host}`]), url]));
// The same request through the proxy the driver pointed the sandbox at (`HTTP_PROXY`).
const viaProxy = async (sandbox, url) => succeeded(await sandbox.exec(['wget', '-Y', 'on', '-q', '-T', '10', '-O', '/dev/null', url]));
// What the proxy answered, read with a raw request so the denial reason is visible: wget exits
// non-zero for a 403 without printing the body.
const proxyAnswer = async (sandbox, url) => {
  const { host } = new URL(url);
  const script =
    `p=\${HTTP_PROXY#http://}; printf 'GET ${url} HTTP/1.1\\r\\nHost: ${host}\\r\\nConnection: close\\r\\n\\r\\n' ` +
    `| nc -w 8 \${p%:*} \${p##*:}`;
  return (await sh(sandbox, script)).stdout;
};

// The internet is probed by a literal IP, resolved once on the runner, with the original Host
// header: a sandbox without egress has no DNS either, so a hostname probe would pass on the failed
// name lookup instead of on blocked egress.
const internetHost = new URL(internetUrl).host;
let internetIpUrl = '';
const reachInternet = (sandbox) => reachable(sandbox, internetIpUrl, internetHost);

async function retry(probe, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}
const reachableWithRetry = (sandbox, url) => retry(() => reachable(sandbox, url));
const inSandbox = { exec: (argv, options) => lane.control.exec(argv, options) };

let controls;
async function requireControl(name) {
  controls ??= (async () => {
    const url = new URL(internetUrl);
    url.hostname = (await lookup(url.hostname, { family: 4 })).address;
    internetIpUrl = url.href;
    return {
      decoy: await reachableWithRetry(inSandbox, lane.decoyUrl),
      internet: await retry(() => reachInternet(inSandbox)),
    };
  })();
  if (!(await controls)[name]) {
    throw new Inconclusive(`positive control failed: ${name} is not reachable from an unrestricted workload, so "unreachable" proves nothing`);
  }
}

function status(text) {
  return Object.fromEntries(
    text
      .split('\n')
      .map((line) => line.split(/:\s*/u))
      .filter(([key, value]) => key !== '' && value !== undefined)
      .map(([key, value]) => [key, value.trim()]),
  );
}

let hardened;
before(async () => {
  await lane.setup();
  hardened = await lane.create('hardened', { policy: 'gateway', memoryMb: MEMORY_MB, ...DOCKER_DISK });
});

after(async () => {
  await lane.teardown();
});

check('identity', 'runs as uid and gid 1000', async () => {
  assert.equal((await hardened.exec(['id', '-u'])).stdout.trim(), '1000');
  assert.equal((await hardened.exec(['id', '-g'])).stdout.trim(), '1000');
});

check('capabilities', 'all capabilities dropped', async () => {
  const fields = status((await hardened.exec(['cat', '/proc/self/status'])).stdout);
  for (const key of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
    assert.match(fields[key] ?? '', /^0+$/u, `${key} must be empty, got ${String(fields[key])}`);
  }
});

check('no-new-privileges', 'privilege escalation is blocked', async () => {
  const fields = status((await hardened.exec(['cat', '/proc/self/status'])).stdout);
  assert.equal(fields['NoNewPrivs'], '1');
});

check('read-only-root', 'root filesystem is read-only, /tmp is writable', async () => {
  assert.notEqual((await sh(hardened, 'echo x > /aw-isolation-probe')).code, 0, 'writing to / must fail');
  const tmp = await sh(hardened, 'echo x > /tmp/aw-isolation-probe && cat /tmp/aw-isolation-probe');
  assert.equal(tmp.stdout.trim(), 'x', '/tmp must stay writable');
});

check('memory-limit', 'memory limit is set in the cgroup', async () => {
  const limit = await sh(hardened, 'cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes');
  assert.equal(
    limit.stdout.trim(),
    String(LIMIT_MB * 1024 * 1024),
    `memory.max must be ${String(LIMIT_MB)} MiB (memoryMb ${String(MEMORY_MB)} + workspace ${String(LIMIT_MB - MEMORY_MB)})`,
  );
});

check('memory-enforced', 'a process over the memory limit is killed', async () => {
  await withSandbox('memory', { policy: 'gateway', memoryMb: MEMORY_MB, ...DOCKER_DISK }, async (sandbox) => {
    // The hog runs in a child shell so the exec shell can report how it ended.
    const allocate = (bytes) =>
      sh(sandbox, `sh -c 'x=$(yes | head -c ${String(bytes)}); echo survived'; echo "child-exit=$?"`);
    const oomKills = async () =>
      Number((await sh(sandbox, "sed -n 's/^oom_kill //p' /sys/fs/cgroup/memory.events")).stdout.trim());
    // Kubernetes may kill the whole container on OOM (cgroup v2 oom.group) and restart it, which
    // resets memory.events; the pod status then keeps the evidence.
    const podOomReason = async () => {
      if (!isKind) return '';
      const state = await lane.kubectl(
        'get', 'pod', sandbox.pod, '-n', sandbox.namespace, '-o',
        'jsonpath={.status.containerStatuses[?(@.name=="runtime")].lastState.terminated.reason}/{.status.containerStatuses[?(@.name=="runtime")].state.terminated.reason}',
      );
      return state.stdout.trim();
    };
    // On some kernels (7.0 on the self-hosted CI host) the limit is hit in the POD cgroup, whose
    // 128 MiB also holds the pause container, not in the container's: the kernel kills the hog
    // (oom.group takes the container with it, resetting its memory.events) and containerd reports
    // "Error", not "OOMKilled". The pod cgroup outlives the restart and keeps the count. A kind node
    // is a Docker container named after the node, so the count is read through `docker exec`.
    const podCgroupOomKills = async () => {
      if (!isKind) return 0;
      const pod = await lane.kubectl(
        'get', 'pod', sandbox.pod, '-n', sandbox.namespace, '-o', 'jsonpath={.metadata.uid} {.spec.nodeName}',
      );
      const [uid = '', node = ''] = pod.stdout.trim().split(' ');
      if (uid === '' || node === '') return 0;
      const events = await run('docker', [
        'exec', node, 'sh', '-c',
        `cat "$(find /sys/fs/cgroup/kubelet.slice -maxdepth 3 -type d -name '*pod${uid.replaceAll('-', '_')}.slice')/memory.events"`,
      ]);
      return Number(/^oom_kill (\d+)$/mu.exec(events.stdout)?.[1] ?? 0);
    };
    assert.match((await allocate(16_000_000)).stdout, /survived/u, 'a small allocation must work');
    assert.equal(await oomKills(), 0, 'nothing may have been OOM-killed before the stress');
    const overBytes = (LIMIT_MB + 256) * 1024 * 1024;
    const over = await allocate(overBytes);
    assert.doesNotMatch(
      over.stdout,
      /survived/u,
      `an allocation of ${String(overBytes)} bytes over the ${String(LIMIT_MB)} MiB limit must be killed`,
    );
    // Without this, any unrelated exec failure would also read as "killed by the memory limit".
    let kills = Number.NaN;
    let podKills = 0;
    let reason = '';
    for (let attempt = 0; attempt < 15; attempt += 1) {
      kills = await oomKills();
      reason = await podOomReason();
      podKills = await podCgroupOomKills();
      if (kills > 0 || podKills > 0 || reason.includes('OOMKilled')) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    assert.ok(
      kills > 0 || podKills > 0 || reason.includes('OOMKilled'),
      `the cgroup or pod must record an OOM kill: oom_kill=${String(kills)}, pod cgroup oom_kill=${String(podKills)}, ` +
        `pod reason=${JSON.stringify(reason)}, ` +
        `stdout=${JSON.stringify(over.stdout.trim())}, stderr=${JSON.stringify(over.stderr.trim())}`,
    );
  });
});

check('pids-limit', 'a fork bomb is stopped at the pids limit', async () => {
  if (isKind) return notApplicable('the kubernetes driver sets no pids limit; it is a kubelet setting (podPidsLimit)');
  const limit = await sh(hardened, 'cat /sys/fs/cgroup/pids.max');
  assert.equal(limit.stdout.trim(), '256');
  const forkFailures = async () =>
    Number((await sh(hardened, "sed -n 's/^max //p' /sys/fs/cgroup/pids.events")).stdout.trim());
  assert.equal(await forkFailures(), 0, 'no fork may have failed before the stress');
  const stress = await sh(hardened, 'i=0; while [ $i -lt 600 ]; do sleep 5 & i=$((i+1)); done');
  // Wait for the background sleeps to exit so the inspection itself can fork.
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  // Either the shell reports a refused fork or the cgroup counts one: on the CI runners the
  // container's pids.events max stays 0 even though pids.max holds.
  const refusedInShell = /can't fork|Resource temporarily unavailable/u.test(stress.stderr);
  const events = await forkFailures();
  assert.ok(
    refusedInShell || events > 0,
    `forks past the limit must have been refused: pids.events max=${String(events)}, stderr=${JSON.stringify(stress.stderr.trim().slice(0, 300))}`,
  );
});

check('network-none', 'none: no egress to the internet or another workload', async () => {
  await requireControl('decoy');
  await requireControl('internet');
  await withSandbox('none', { policy: 'none' }, async (sandbox) => {
    assert.equal(await reachable(sandbox, lane.decoyUrl), false, 'the decoy workload must be unreachable');
    assert.equal(await reachInternet(sandbox), false, 'the internet must be unreachable');
    if (isKind) {
      assert.equal(await reachable(sandbox, lane.gatewayUrl), false, 'a none pod must not reach the gateway either');
    }
  });
});

check('network-gateway', 'gateway: reaches the gateway and nothing else', async () => {
  await requireControl('decoy');
  await requireControl('internet');
  // Kubernetes: no run spec, so the driver's default policy set applies. Docker: its `none` is
  // the internal network that carries the gateway.
  await withSandbox('gateway', { policy: 'gateway' }, async (sandbox) => {
    assert.equal(await reachableWithRetry(sandbox, lane.gatewayUrl), true, `the gateway must be reachable (${lastFailure})`);
    assert.equal(await reachable(sandbox, lane.decoyUrl), false, 'the decoy workload must be unreachable');
    assert.equal(await reachInternet(sandbox), false, 'the internet must be unreachable');
  });
});

check('network-policy-objects', 'default-deny NetworkPolicy is present', async () => {
  if (!isKind) return notApplicable('docker has no NetworkPolicy objects; the network checks cover the behaviour');
  // In the release namespace the control plane lives beside the sandboxes, so the policy is named
  // after the pod and selects it by its labels, not every pod.
  const name = isChart ? `default-deny-egress-${hardened.pod}` : 'default-deny-egress';
  const { stdout } = await lane.kubectl('get', 'networkpolicy', name, '-n', hardened.namespace, '-o', 'json');
  const spec = JSON.parse(stdout).spec;
  if (isChart) {
    assert.equal(spec.podSelector.matchLabels?.['agent-workspace/runtime'], hardened.pod);
    assert.ok(spec.podSelector.matchLabels?.['agent-workspace/session'], 'the policy must select the session label');
  } else {
    assert.deepEqual(spec.podSelector, {});
  }
  assert.deepEqual(spec.policyTypes, ['Egress']);
  assert.deepEqual(spec.egress ?? [], []);
});

check('deadline', 'the run deadline is enforced', async () => {
  if (!isKind) return notApplicable('the docker driver does not enforce the run deadline yet (A3, #783)');
  await withSandbox('deadline', { policy: 'gateway', timeoutSeconds: 30 }, async (sandbox) => {
    const get = async (jsonpath) =>
      (await lane.kubectl('get', 'pod', sandbox.pod, '-n', sandbox.namespace, '-o', `jsonpath=${jsonpath}`)).stdout.trim();
    assert.equal(await get('{.spec.activeDeadlineSeconds}'), '30');
    const until = Date.now() + 150_000;
    while ((await get('{.status.phase}')) !== 'Failed' && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    assert.equal(await get('{.status.phase}'), 'Failed');
    assert.equal(await get('{.status.reason}'), 'DeadlineExceeded');
  });
});

check('teardown', 'destroy leaves no container, pod or volume behind', async () => {
  const sandbox = await lane.create('teardown', { policy: 'gateway' });
  assert.notDeepEqual(await lane.leftovers(sandbox, 0), [], 'the sandbox must exist before destroy');
  await lane.destroy(sandbox);
  assert.deepEqual(await lane.leftovers(sandbox), []);
});

// ADR-0117: `restricted` and `open` reach the internet only through the per-session egress proxy.
// The sandbox's own route out stays closed (`reachable` ignores the proxy variables), and the
// proxy names the refusal in its answer, so a block is read from the proxy and not inferred from a
// timeout.
const internetHostname = new URL(internetUrl).hostname;
const DENIED_HOST_URL = 'http://aw-isolation-denied.invalid/';
const METADATA_URL = 'http://169.254.169.254/';

async function assertRefusedByProxy(sandbox, url, reason, what) {
  assert.match(await proxyAnswer(sandbox, url), new RegExp(`"reason":"${reason}"`, 'u'), `the proxy must refuse ${what} as ${reason}`);
  assert.equal(await viaProxy(sandbox, url), false, `${what} must be unreachable through the proxy`);
}

check('network-restricted', 'restricted: only allowed domains are reachable', async () => {
  await requireControl('decoy');
  await requireControl('internet');
  await withSandbox('restricted', { policy: 'restricted', allowedDomains: [internetHostname] }, async (sandbox) => {
    assert.equal(await retry(() => viaProxy(sandbox, internetUrl)), true, `the allowed domain must be reachable through the proxy (${lastFailure})`);
    await assertRefusedByProxy(sandbox, DENIED_HOST_URL, 'host_not_allowed', 'a domain outside the allowlist');
    await assertRefusedByProxy(sandbox, lane.decoyUrl, 'address_private', 'the decoy workload');
    await assertRefusedByProxy(sandbox, METADATA_URL, 'address_link_local', 'the metadata address');
    assert.equal(await reachInternet(sandbox), false, 'the allowed domain must not be reachable around the proxy');
    assert.equal(await reachable(sandbox, lane.decoyUrl), false, 'the decoy workload must not be reachable around the proxy');
  });
});

check('network-restricted-dns', 'restricted: external names do not resolve (no DNS exfiltration)', async () => {
  const lookupExternal = (workload) => workload.exec(['nslookup', '-timeout=4', 'example.com']);
  const control = await lookupExternal(inSandbox);
  if (control.code !== 0) {
    throw new Inconclusive(`positive control failed: an unrestricted workload cannot resolve example.com, so a failed lookup proves nothing: ${control.stderr.trim() || control.stdout.trim()}`);
  }
  await withSandbox('restricted-dns', { policy: 'restricted', allowedDomains: [internetHostname] }, async (sandbox) => {
    const answer = await lookupExternal(sandbox);
    assert.notEqual(answer.code, 0, `the sandbox must not resolve an external name: ${answer.stdout.trim()}`);
  });
});

check('network-open', 'open: the public internet through the proxy, not the LAN', async () => {
  await requireControl('decoy');
  await requireControl('internet');
  await withSandbox('open', { policy: 'open' }, async (sandbox) => {
    assert.equal(await retry(() => viaProxy(sandbox, internetUrl)), true, `the internet must be reachable through the proxy (${lastFailure})`);
    await assertRefusedByProxy(sandbox, lane.decoyUrl, 'address_private', 'the decoy workload');
    assert.equal(await reachInternet(sandbox), false, 'the internet must not be reachable around the proxy');
    assert.equal(await reachable(sandbox, lane.decoyUrl), false, 'the decoy workload must not be reachable around the proxy');
  });
});

check('network-metadata', 'open: the cloud metadata address 169.254.169.254 is blocked', async () => {
  await requireControl('internet');
  await withSandbox('metadata', { policy: 'open' }, async (sandbox) => {
    let answer = '';
    assert.equal(
      await retry(async () => /"reason":"address_link_local"/u.test((answer = await proxyAnswer(sandbox, METADATA_URL)))),
      true,
      `the proxy must answer before it is probed (it answered: ${JSON.stringify(answer.slice(0, 300))})`,
    );
    await assertRefusedByProxy(sandbox, METADATA_URL, 'address_link_local', 'the metadata address');
    assert.equal(await reachable(sandbox, METADATA_URL), false, 'the metadata address must not be reachable around the proxy');
  });
});

// ADR-0118 TS4: a tool sandbox gets its secrets as a file written over standard input, so they are
// in neither the container's arguments nor its environment.
check('tool-sandbox-writefile-secrets', 'a tool sandbox receives secrets as a file, not as arguments or environment', async () => {
  if (isKind) return notApplicable('the tool sandbox is placed by the docker driver; kubernetes follows (C3, #796)');
  const secret = 'aw-isolation-secret-0f3a9c';
  await withSandbox('tool-secrets', { policy: 'none' }, async (sandbox) => {
    await lane.writeFile(sandbox, 'manifest.json', JSON.stringify({ env: { KEY: secret } }));
    const read = await sandbox.exec(['cat', '/workspace/manifest.json']);
    assert.equal(read.code, 0, read.stderr);
    assert.match(read.stdout, new RegExp(secret, 'u'), 'the file must hold the manifest');
    const inspected = await lane.inspect(sandbox);
    assert.equal(inspected.includes(secret), false, 'the secret must not appear in the container configuration');
  });
});

// ADR-0118 TS5: a tool sandbox takes calls from the gateway only, so an agent sandbox must not reach
// one. The positive control is a second tool sandbox: it shares the tool network, as the gateway
// does (and, a known limit until per-session tool networks land in #841, every other tool sandbox).
check('tool-sandbox-agent-unreachable', 'an agent sandbox cannot open a TCP connection to a tool sandbox', async () => {
  if (isKind) return notApplicable('the tool sandbox is placed by the docker driver; kubernetes follows (C3, #796)');
  await withSandbox('tool-listener', { policy: 'none', tool: true }, async (tool) => {
    // Busybox httpd without `-f` goes to the background, so the sandbox keeps serving.
    const started = await sh(tool, 'httpd -p 8788 -h /www');
    assert.equal(started.code, 0, started.stderr);
    const url = `http://${await lane.toolAddress(tool)}:8788/`;
    await withSandbox('tool-peer', { policy: 'none', tool: true }, async (peer) => {
      if (!(await reachableWithRetry(peer, url))) {
        throw new Inconclusive('positive control failed: the tool sandbox is not reachable on its own network, so "unreachable" proves nothing');
      }
    });
    await withSandbox('agent-to-tool', { policy: 'none' }, async (agent) => {
      assert.equal(await reachable(agent, url), false, 'an agent sandbox must not reach a tool sandbox');
    });
  });
});

check('network-proxy-teardown', 'destroy removes the egress proxy with the sandbox', async () => {
  const sandbox = await lane.create('proxy-teardown', { policy: 'open' });
  assert.notDeepEqual(await lane.leftovers(sandbox, 0), [], 'the sandbox and its proxy must exist before destroy');
  await lane.destroy(sandbox);
  assert.deepEqual(await lane.leftovers(sandbox), []);
});
