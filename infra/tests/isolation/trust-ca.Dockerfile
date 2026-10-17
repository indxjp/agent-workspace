# A platform image that trusts the throwaway CA of the in-cluster fake Anthropic API and exempts
# its host from the private-range egress check (the fake answers from a ClusterIP). The chart has no
# extra-environment or volume values, so the trust is baked into the image instead.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY ca.pem /etc/aw-e2e/ca.pem
ENV NODE_EXTRA_CA_CERTS=/etc/aw-e2e/ca.pem \
    EGRESS_ALLOW_HOSTS=api.anthropic.com
