# Supply a trusted, digest-pinned image containing Linux Node, Grok Build,
# Claude Code, and the project's test toolchain. Do not bake credentials into it.
ARG TOOLCHAIN_IMAGE
FROM ${TOOLCHAIN_IMAGE}
USER root
COPY automation/agent-json.mjs /opt/issue-agent/agent-json.mjs
RUN chmod 0555 /opt/issue-agent/agent-json.mjs
WORKDIR /workspace
USER 65532:65532
