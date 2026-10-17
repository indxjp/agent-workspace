# Security policy

## Supported versions

Security fixes are released for:

- the latest `0.x` minor of the `@indx-workspace/*` packages, and
- the latest platform images.

Older minors receive no fixes; upgrade to the latest minor first.

## Reporting a vulnerability

Use **Report a vulnerability** on the Security tab:
https://github.com/indxjp/agent-workspace/security/advisories/new.
Do not open a public issue.

## What to expect

- Acknowledgement within 5 business days.
- A fix or a mitigation plan within 30 days.
- Coordinated disclosure, with credit to the reporter unless you prefer otherwise.

## Scope

In scope: the code and the images built from this repository.

Out of scope: third-party providers and services (model providers, cloud platforms, package
registries). Report those to the provider concerned.

## Hardening guidance

For the threat model and the controls a deployment should apply, read
[`docs/spec.md`](docs/spec.md) and [`docs/deploy/single-vm.md`](docs/deploy/single-vm.md).
