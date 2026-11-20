# The engine runtime image (it carries node) plus the Cloud Run isolation lane script. The jobs of
# the lane run it with `--command node`. Build context: infra/tests/isolation.
ARG RUNTIME_IMAGE
FROM ${RUNTIME_IMAGE}
COPY cloud-run-lane.mjs /opt/aw-lane/cloud-run-lane.mjs
COPY attempts.mjs /opt/aw-lane/attempts.mjs
COPY lane-result.mjs /opt/aw-lane/lane-result.mjs
COPY manager-client.mjs /opt/aw-lane/manager-client.mjs
COPY probe-evaluation.mjs /opt/aw-lane/probe-evaluation.mjs
COPY proxy-attempts.mjs /opt/aw-lane/proxy-attempts.mjs
COPY proxy-evaluation.mjs /opt/aw-lane/proxy-evaluation.mjs
COPY proxy-lane.mjs /opt/aw-lane/proxy-lane.mjs
COPY tool-lane.mjs /opt/aw-lane/tool-lane.mjs
COPY tool-probe.mjs /opt/aw-lane/tool-probe.mjs
