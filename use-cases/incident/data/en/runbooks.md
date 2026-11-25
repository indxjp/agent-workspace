# Runbooks (first steps)

The first-response part of the incident runbooks of Minato Trading, a fictional company.

## RB-ORDER-01 order-api

1. Check the share of 5xx responses and the latest release on the monitoring dashboard.
2. If there was a recent release, ask its release owner whether to roll it back.
3. Check whether a shared-db connection alert is firing at the same time.

## RB-PAY-01 payment-gateway

1. Check the payment provider's status page.
2. If the authorization error rate stays high, page the incident commander.
3. Ask communications to prepare a notice for the stores and the call center.

## RB-DATA-03 nightly-report

1. Find the step that stopped in the job's run log.
2. If the rerun will not finish before the stores open, prepare a notice for the stores.

## RB-INFRA-02 shared-db

1. Check the connection count and the slowest queries.
2. Ask the order and payment teams whether they see an impact.
