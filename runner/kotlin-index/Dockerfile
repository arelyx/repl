# Layers the pre-built Kotlin LSP index (made by warm.sh in a capped
# container) onto the runner image. Built by runner/build.sh.
ARG BASE=replit-polyglot:stage
FROM ${BASE}
COPY --chown=root:root index-seed/ /opt/lsp/kotlin-lsp/index-seed/
