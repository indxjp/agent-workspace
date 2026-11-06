# The engine runtime image (it carries node) plus the Cloud Run isolation lane script. The jobs of
# the lane run it with `--command node`. Build context: infra/tests/isolation.
ARG RUNTIME_IMAGE
FROM ${RUNTIME_IMAGE}
COPY cloud-run-lane.mjs /opt/aw-lane/cloud-run-lane.mjs
