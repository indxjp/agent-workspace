import assert from 'node:assert/strict';
import test from 'node:test';

import { networkPolicy, read } from './contracts.test-support.mjs';

/**
 * #849: the chart default-denies every pod, so each connection a component makes needs an egress
 * allowance on the caller and, where the callee is a pod of the release, an ingress allowance on
 * the callee. Without them web, the migrate Job and the runner manager cannot resolve a name or
 * reach PostgreSQL.
 */
const selectedPods = (block) =>
  [...(/values: \[([^\]]+)\]/u.exec(block)?.[1] ?? '').matchAll(/agent-workspace-[a-z-]+/gu)].map(
    ([name]) => name,
  );

test('the chart opens DNS and PostgreSQL egress by pod label under the default deny', async () => {
  const policy = await networkPolicy();
  const base = await read('infra/helm/agent-workspace/values.yaml');
  const schema = JSON.parse(await read('infra/helm/agent-workspace/values.schema.json'));

  assert.match(policy('agent-workspace-default-deny'), /ingress: \[\]\n {2}egress: \[\]/u);

  const dns = policy('agent-workspace-dns');
  assert.deepEqual(selectedPods(dns), [
    'agent-workspace-web',
    'agent-workspace-gateway',
    'agent-workspace-runner-manager',
    'agent-workspace-migrate',
  ]);
  assert.match(dns, /kubernetes\.io\/metadata\.name: \{\{ \.Values\.dns\.namespace \| quote \}\}/u);
  assert.match(dns, /matchLabels: \{\{ toJson \.Values\.dns\.podSelector \}\}/u);
  assert.match(dns, /protocol: UDP, port: 53/u);
  assert.match(dns, /protocol: TCP, port: 53/u);
  assert.match(
    base,
    /^dns:\n {2}namespace: kube-system\n {2}podSelector:\n {4}k8s-app: kube-dns$/mu,
  );

  const database = policy('agent-workspace-database');
  assert.deepEqual(selectedPods(database), [
    'agent-workspace-web',
    'agent-workspace-gateway',
    'agent-workspace-runner-manager',
    'agent-workspace-migrate',
  ]);
  assert.match(database, /port: \{\{ \.Values\.database\.port \}\}/u);
  assert.match(database, /include "agent-workspace\.egressTo" \.Values\.database/u);
  // One helper renders every `to:`: a cidr peer, and a podSelector peer that carries the
  // namespaceSelector when the destination is in another namespace.
  const helpers = await read('infra/helm/agent-workspace/templates/_helpers.tpl');
  assert.match(helpers, /"ipBlock" \$block/u);
  assert.match(helpers, /"podSelector" \(dict "matchLabels" \./u);
  assert.match(
    helpers,
    /with \$\.namespace \}\}\n.*set \$peer "namespaceSelector" \(dict "matchLabels" \(dict "kubernetes\.io\/metadata\.name" \.\)\)/u,
  );
  assert.match(
    base,
    /^database:\n {2}port: 5432\n {2}cidr: ''\n {2}podSelector: \{\}\n {2}namespace: ''$/mu,
  );
  assert.deepEqual(schema.properties.database.properties.namespace, { type: 'string' });
  assert.equal(schema.properties.database.additionalProperties, false);
  assert.equal(schema.properties.database.properties.port.maximum, 65535);

  const job = await read('infra/helm/agent-workspace/templates/migrate-job.yaml');
  assert.match(job, /app\.kubernetes\.io\/name: "agent-workspace-migrate"/u);
});

test('the chart pairs every pod-to-pod egress allowance with an ingress allowance', async () => {
  const policy = await networkPolicy();

  const gatewayIn = policy('gateway-from-runner');
  assert.match(gatewayIn, /policyTypes: \[Ingress\]/u);
  assert.match(
    gatewayIn,
    /podSelector: \{ matchLabels: \{ app\.kubernetes\.io\/name: agent-workspace-gateway \} \}/u,
  );
  assert.match(
    gatewayIn,
    /from: \[\{ podSelector: \{ matchLabels: \{ app\.kubernetes\.io\/name: agent-workspace-runner-manager/u,
  );
  assert.match(gatewayIn, /port: 4000/u);
  assert.match(policy('runner-to-gateway'), /port: 4000/u);

  const runnerIn = policy('runner-manager-from-web');
  assert.match(runnerIn, /policyTypes: \[Ingress\]/u);
  assert.match(
    runnerIn,
    /from: \[\{ podSelector: \{ matchLabels: \{ app\.kubernetes\.io\/name: agent-workspace-web/u,
  );
  assert.match(runnerIn, /port: 8080/u);
  const webOut = policy('web-to-runner-manager');
  assert.match(webOut, /policyTypes: \[Egress\]/u);
  assert.match(webOut, /port: 8080/u);

  // #1846: the gateway forwards aw-control calls to web's Service: gateway pods to web pods on
  // TCP 3000, and nothing wider (no namespace, no address block, no sandbox).
  const pod = (name) =>
    `\\{ podSelector: \\{ matchLabels: \\{ app\\.kubernetes\\.io\\/name: ${name} \\} \\} \\}`;
  const only3000 = '\\n {6}ports: \\[\\{ protocol: TCP, port: 3000 \\}\\]\\n$';
  const gatewayOut = policy('gateway-to-web');
  assert.match(gatewayOut, /policyTypes: \[Egress\]/u);
  assert.match(
    gatewayOut,
    /spec:\n {2}podSelector: \{ matchLabels: \{ [^}]+agent-workspace-gateway \} \}/u,
  );
  assert.match(gatewayOut, new RegExp(`- to: \\[${pod('agent-workspace-web')}\\]${only3000}`, 'u'));
  const webIn = policy('web-from-gateway');
  assert.match(webIn, /policyTypes: \[Ingress\]/u);
  assert.match(
    webIn,
    new RegExp(`- from: \\[${pod('agent-workspace-gateway')}\\]${only3000}`, 'u'),
  );
  for (const block of [gatewayOut, webIn]) {
    assert.doesNotMatch(block, /namespaceSelector|ipBlock|agent-runtime/u);
  }
  const deployments = await read('infra/helm/agent-workspace/templates/deployments.yaml');
  assert.match(
    deployments,
    /if eq \$name "gateway" \}\}\n(?: *#.*\n)* *- \{ name: GATEWAY_CONTROL_PLANE_ORIGIN, value: \{\{ printf "http:\/\/agent-workspace-web:%v" \(index \$ports "web"\) \| quote \}\} \}/u,
  );
});

test('the chart opens the object store, the model providers and the Kubernetes API, and no more', async () => {
  const policy = await networkPolicy();
  const base = await read('infra/helm/agent-workspace/values.yaml');
  const schema = JSON.parse(await read('infra/helm/agent-workspace/values.schema.json'));

  const objectStore = policy('web-to-object-store');
  assert.match(objectStore, /app\.kubernetes\.io\/name: agent-workspace-web \}/u);
  assert.match(objectStore, /port: \{\{ \.Values\.objectStore\.port \}\}/u);
  assert.match(objectStore, /include "agent-workspace\.egressTo" \.Values\.objectStore/u);

  const providers = policy('agent-workspace-providers');
  assert.deepEqual(selectedPods(providers), ['agent-workspace-web', 'agent-workspace-gateway']);
  assert.match(providers, /port: \{\{ \.Values\.providers\.port \}\}/u);
  assert.match(providers, /include "agent-workspace\.egressTo" \.Values\.providers/u);
  assert.match(
    base,
    /^providers:\n {2}port: 443\n {2}cidr: 0\.0\.0\.0\/0\n {2}except: \[10\.0\.0\.0\/8, 172\.16\.0\.0\/12, 192\.168\.0\.0\/16, 169\.254\.0\.0\/16\]$/mu,
  );

  const api = policy('runner-manager-to-kubernetes-api');
  assert.match(api, /app\.kubernetes\.io\/name: agent-workspace-runner-manager \}/u);
  assert.match(api, /range \.Values\.kubernetesApi\.ports/u);
  assert.match(api, /ipBlock: \{ cidr: \{\{ \. \| quote \}\} \}/u);
  assert.match(base, /^kubernetesApi:\n {2}cidr: ''\n {2}ports: \[443, 6443\]$/mu);

  for (const key of ['objectStore', 'providers', 'kubernetesApi']) {
    assert.equal(schema.properties[key].additionalProperties, false, key);
  }
  assert.equal(schema.properties.providers.properties.except.type, 'array');
});

test('the chart lets the runner manager reach the sandboxes it creates, and only them', async () => {
  const policy = await networkPolicy();
  const policies = await read('infra/helm/agent-workspace/templates/networkpolicy.yaml');
  assert.match(policies, /\{\{- if eq \.Values\.runtime\.driver "kubernetes" \}\}/u);

  const out = policy('runner-manager-to-agent-runtime');
  assert.match(out, /policyTypes: \[Egress\]/u);
  assert.match(out, /matchLabels: \{ app\.kubernetes\.io\/name: agent-runtime \}/u);
  assert.match(out, /port: 8080/u);

  const sandboxIn = policy('agent-runtime-from-runner-manager');
  assert.match(sandboxIn, /policyTypes: \[Ingress\]/u);
  assert.match(
    sandboxIn,
    /from: \[\{ podSelector: \{ matchLabels: \{ app\.kubernetes\.io\/name: agent-workspace-runner-manager/u,
  );
  assert.match(sandboxIn, /port: 8080/u);

  const gatewayIn = policy('gateway-from-agent-runtime');
  assert.match(gatewayIn, /policyTypes: \[Ingress\]/u);
  assert.match(
    gatewayIn,
    /from: \[\{ podSelector: \{ matchLabels: \{ app\.kubernetes\.io\/name: agent-runtime/u,
  );
  assert.match(gatewayIn, /port: 4000/u);
});

test('the runner manager creates sandbox Pods under a namespaced Role and runs one replica', async () => {
  const serviceAccounts = await read('infra/helm/agent-workspace/templates/serviceaccount.yaml');
  const deployments = await read('infra/helm/agent-workspace/templates/deployments.yaml');
  const autoscalers = await read(
    'infra/helm/agent-workspace/templates/horizontalpodautoscalers.yaml',
  );
  const base = await read('infra/helm/agent-workspace/values.yaml');
  const schema = JSON.parse(await read('infra/helm/agent-workspace/values.schema.json'));

  // Namespaced, never cluster-wide: the sandboxes live in the release namespace.
  assert.doesNotMatch(serviceAccounts, /ClusterRole/u);
  // Exactly what the shared-namespace driver uses: no `serviceaccounts` or `pods/log`.
  const rules = [
    ...serviceAccounts.matchAll(/resources: (\[[^\]]*\])\n(?:\s*#.*\n)*\s+verbs: (\[[^\]]*\])/gu),
  ].map(([, resources, verbs]) => [JSON.parse(resources), JSON.parse(verbs)]);
  assert.deepEqual(rules, [
    [['pods'], ['get', 'list', 'watch', 'create', 'delete']],
    [['services'], ['get', 'create', 'delete']],
    [['networkpolicies'], ['get', 'list', 'watch', 'create', 'delete']],
  ]);
  assert.equal([...serviceAccounts.matchAll(/^\s+- apiGroups:/gmu)].length, rules.length);
  // The sandbox identity holds no Role and no token.
  assert.match(serviceAccounts, /name: agent-runtime\nautomountServiceAccountToken: false/u);

  for (const name of [
    'RUNTIME_KUBERNETES_NAMESPACE',
    'RUNTIME_GATEWAY_SERVICE',
    'AGENT_WORKSPACE_EGRESS_PROXY_IMAGE',
  ]) {
    assert.match(deployments, new RegExp(name, 'u'), name);
  }
  assert.match(deployments, /fieldPath: metadata\.namespace/u);
  assert.match(
    deployments,
    /RUNTIME_DRIVER, value: \{\{ \$\.Values\.runtime\.driver \| quote \}\}/u,
  );
  assert.match(base, /^runtime:\n {2}driver: kubernetes\n {2}egressProxyImage: ''$/mu);
  assert.match(base, /^ {2}runnerManager: 1$/mu);
  assert.equal(schema.properties.runtime.additionalProperties, false);

  // The allocation registry is process-local, so the manager is neither autoscaled nor given more
  // than the replicas the values state.
  assert.match(autoscalers, /range \$name := list "web" "gateway"/u);
  assert.match(
    deployments,
    /or \(not \$\.Values\.autoscaling\.enabled\) \(eq \$name "runner-manager"\)/u,
  );
});

test('the chart renders an Ingress with cert-manager TLS only when asked, and carries the policy', async () => {
  const ingress = await read('infra/helm/agent-workspace/templates/ingress.yaml');
  const policies = await read('infra/helm/agent-workspace/templates/networkpolicy.yaml');
  const deployments = await read('infra/helm/agent-workspace/templates/deployments.yaml');
  const base = await read('infra/helm/agent-workspace/values.yaml');
  const schema = JSON.parse(await read('infra/helm/agent-workspace/values.schema.json'));

  assert.match(ingress, /^\{\{- if \.Values\.ingress\.enabled \}\}/u);
  assert.match(ingress, /required "ingress\.host is required when ingress\.enabled"/u);
  assert.match(
    ingress,
    /cert-manager\.io\/cluster-issuer: \{\{ \.Values\.ingress\.tls\.clusterIssuer \| quote \}\}/u,
  );
  assert.match(ingress, /secretName: agent-workspace-tls/u);
  assert.match(ingress, /service: \{ name: agent-workspace-web, port: \{ number: 3000 \} \}/u);
  assert.match(base, /^ingress:\n {2}enabled: false$/mu);
  assert.equal(schema.properties.ingress.additionalProperties, false);

  assert.match(
    policies,
    /\{\{- if \.Values\.ingress\.enabled \}\}[\s\S]*web-from-ingress-controller[\s\S]*port: 3000/u,
  );

  assert.match(
    deployments,
    /if and \(eq \$name "web"\) \$\.Values\.deploymentPolicy[\s\S]*name: AW_DEPLOYMENT_POLICY, value: \{\{ \$\.Values\.deploymentPolicy \| quote \}\}/u,
  );
  assert.match(base, /^deploymentPolicy: ''$/mu);
  assert.deepEqual(schema.properties.deploymentPolicy, { type: 'string' });

  // ADR-0160 D5 (#1495): the project's features, rendered only when set, so an empty value
  // renders the web Deployment exactly as before.
  assert.match(
    deployments,
    /if and \(eq \$name "web"\) \$\.Values\.deploymentFeatures[\s\S]*name: AW_DEPLOYMENT_FEATURES, value: \{\{ \$\.Values\.deploymentFeatures \| quote \}\}/u,
  );
  assert.match(base, /^deploymentFeatures: ''$/mu);
  assert.deepEqual(schema.properties.deploymentFeatures, {
    type: 'string',
    pattern: '^([a-z]+(,[a-z]+)*)?$',
  });

  assert.match(
    deployments,
    /if and \(eq \$name "web"\) \$\.Values\.publicUrl[\s\S]*name: AW_PUBLIC_URL, value: \{\{ \$\.Values\.publicUrl \| quote \}\}/u,
  );
  assert.match(base, /^publicUrl: ''$/mu);
  assert.deepEqual(schema.properties.publicUrl, { type: 'string' });
});
