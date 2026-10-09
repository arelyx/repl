# syntax=docker/dockerfile:1.7
#
# "polyglot": one image with every toolchain, in the spirit of Replit's
# "polygott". Every repl container runs it.
#
# Distro packages lag upstream by months or years, so every language whose
# distro build isn't the current upstream release is installed from its
# official upstream channel at the version pinned below. Pins keep builds
# reproducible; `python3 runner/update-versions.py` bumps them all to the
# latest stable releases, and `make versions` prints what an image contains.

# ── Toolchain versions ─────────────────────────────────────────────────────
ARG UBUNTU_VERSION=26.04
ARG GCC_VERSION=16.2
ARG LLVM_VERSION=23
ARG PYTHON_VERSION=3.14.8
ARG NODE_VERSION=26.10.0
ARG GO_VERSION=1.27.1
ARG RUST_VERSION=1.99.0
ARG JAVA_VERSION=jdk-27+35
ARG MAVEN_VERSION=3.10.0
ARG KOTLIN_VERSION=2.4.20
ARG DOTNET_SDK_VERSION=10.0.401
ARG RUBY_VERSION=4.0.7
ARG PHP_VERSION=8.5.11
ARG PERL_VERSION=5.44.0
ARG LUA_VERSION=5.5.1
ARG GHC_VERSION=9.14.1
ARG SBCL_VERSION=2.6.9
ARG NASM_VERSION=3.02
# ───────────────────────────────────────────────────────────────────────────

FROM gcc:${GCC_VERSION} AS gcc

# Shared base for languages built from source.
FROM ubuntu:${UBUNTU_VERSION} AS builder
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils bzip2 build-essential autoconf bison re2c pkg-config \
      libssl-dev libyaml-dev zlib1g-dev libffi-dev libreadline-dev libgmp-dev \
      libxml2-dev libsqlite3-dev libcurl4-openssl-dev libonig-dev libicu-dev libzip-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src

FROM builder AS ruby
ARG RUBY_VERSION
RUN curl -fsSL "https://cache.ruby-lang.org/pub/ruby/${RUBY_VERSION%.*}/ruby-${RUBY_VERSION}.tar.gz" | tar xz \
    && cd "ruby-${RUBY_VERSION}" \
    && ./configure --prefix=/opt/ruby --disable-install-doc --enable-shared \
    && make -j"$(nproc)" && make install

FROM builder AS php
ARG PHP_VERSION
RUN curl -fsSL "https://www.php.net/distributions/php-${PHP_VERSION}.tar.xz" | tar xJ \
    && cd "php-${PHP_VERSION}" \
    && ./configure --prefix=/opt/php --with-config-file-path=/opt/php/etc \
         --enable-mbstring --enable-bcmath --enable-intl --enable-sockets --enable-pcntl \
         --with-openssl --with-curl --with-zlib --with-zip --with-readline \
         --with-sqlite3 --with-pdo-sqlite --without-pear \
    && make -j"$(nproc)" && make install \
    && mkdir -p /opt/php/etc && cp php.ini-development /opt/php/etc/php.ini

FROM builder AS perl
ARG PERL_VERSION
RUN curl -fsSL "https://www.cpan.org/src/5.0/perl-${PERL_VERSION}.tar.gz" | tar xz \
    && cd "perl-${PERL_VERSION}" \
    && ./Configure -des -Dprefix=/opt/perl -Dman1dir=none -Dman3dir=none \
    && make -j"$(nproc)" && make install

FROM builder AS small
ARG LUA_VERSION
ARG NASM_VERSION
RUN curl -fsSL "https://www.lua.org/ftp/lua-${LUA_VERSION}.tar.gz" | tar xz \
    && make -C "lua-${LUA_VERSION}" -j"$(nproc)" linux \
    && make -C "lua-${LUA_VERSION}" install INSTALL_TOP=/opt/lua
RUN curl -fsSL "https://www.nasm.us/pub/nasm/releasebuilds/${NASM_VERSION}/nasm-${NASM_VERSION}.tar.xz" | tar xJ \
    && cd "nasm-${NASM_VERSION}" && ./configure --prefix=/opt/nasm \
    && make -j"$(nproc)" && make install

# ── Final image ──
FROM ubuntu:${UBUNTU_VERSION}
ARG LLVM_VERSION PYTHON_VERSION NODE_VERSION GO_VERSION RUST_VERSION JAVA_VERSION \
    MAVEN_VERSION KOTLIN_VERSION DOTNET_SDK_VERSION GHC_VERSION SBCL_VERSION
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Base system, the X stack for the Display tab, and -dev libraries so users
# can build native extensions (and so the source-built languages find their
# shared libraries). Free Pascal and Guile ship as their current upstream
# releases in the distro.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg git less nano vim-tiny unzip zip xz-utils bzip2 \
      procps iproute2 net-tools lsof htop tree jq sqlite3 locales tini file \
      build-essential gdb make cmake ninja-build pkg-config \
      libssl-dev libyaml-dev zlib1g-dev libffi-dev libreadline-dev libgmp-dev libncurses-dev \
      libnuma-dev libxml2-dev libsqlite3-dev libcurl4-openssl-dev libonig-dev libicu-dev libzip-dev \
      fpc guile-3.0 \
      xvfb x11vnc fluxbox novnc websockify xterm x11-apps fonts-dejavu \
    && rm -rf /var/lib/apt/lists/*

# C, C++, Fortran: GCC from the official gcc image (the distro ships GCC 15).
# Its libstdc++ goes first on the loader path so binaries it builds run.
COPY --from=gcc /usr/local/ /usr/local/
# (gccgo's `go`/`gofmt` would shadow the real Go toolchain.)
RUN rm -f /usr/local/bin/go /usr/local/bin/gofmt \
    && echo /usr/local/lib64 > /etc/ld.so.conf.d/000-gcc.conf && ldconfig \
    && gcc --version | head -1

# Clang/LLVM from apt.llvm.org (the distro ships an older major).
RUN curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key | gpg --dearmor -o /usr/share/keyrings/llvm.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/llvm.gpg] https://apt.llvm.org/resolute/ llvm-toolchain-resolute-${LLVM_VERSION} main" \
       > /etc/apt/sources.list.d/llvm.list \
    && apt-get update && apt-get install -y --no-install-recommends \
       clang-${LLVM_VERSION} lld-${LLVM_VERSION} clangd-${LLVM_VERSION} clang-format-${LLVM_VERSION} \
    && for t in clang clang++ clangd clang-format lld ld.lld; do ln -sf "/usr/bin/${t}-${LLVM_VERSION}" "/usr/local/bin/${t}"; done \
    && rm -rf /var/lib/apt/lists/*

# R from CRAN's Ubuntu repository (the distro lags a release behind).
RUN curl -fsSL https://cloud.r-project.org/bin/linux/ubuntu/marutter_pubkey.asc | gpg --dearmor -o /usr/share/keyrings/cran.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cran.gpg] https://cloud.r-project.org/bin/linux/ubuntu resolute-cran40/" \
       > /etc/apt/sources.list.d/cran.list \
    && apt-get update && apt-get install -y --no-install-recommends r-base-core \
    && rm -rf /var/lib/apt/lists/*

# Python: python-build-standalone via uv (bundles Tk, so Tkinter works).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN UV_PYTHON_INSTALL_DIR=/opt/python uv python install "${PYTHON_VERSION}" \
    && py="$(ls -d /opt/python/cpython-${PYTHON_VERSION}-linux-*)" \
    && ln -s "$py" /opt/python/current \
    && rm -f "$py/lib/python${PYTHON_VERSION%.*}/EXTERNALLY-MANAGED" \
    && for b in python3 python pip3 pip; do ln -sf "/opt/python/current/bin/$b" "/usr/local/bin/$b"; done \
    && ln -sf "/opt/python/current/bin/python${PYTHON_VERSION%.*}" "/usr/local/bin/python${PYTHON_VERSION%.*}" \
    && python3 -m pip install --no-cache-dir --upgrade pip \
    && python3 -m pip install --no-cache-dir \
         flask fastapi "uvicorn[standard]" django requests numpy pygame-ce aiohttp \
    && ln -sf /opt/python/current/bin/uvicorn /usr/local/bin/uvicorn

# Node.js (official build) + TypeScript tooling.
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
       | tar xJ -C /opt && ln -s "/opt/node-v${NODE_VERSION}-linux-x64" /opt/node \
    && PATH=/opt/node/bin:$PATH npm install -g --no-fund --no-audit typescript tsx nodemon

# Go (official build).
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar xz -C /usr/local

# Rust via rustup. Toolchains live in /opt; each user gets their own ~/.cargo
# for the registry cache.
ENV RUSTUP_HOME=/opt/rustup
RUN curl -fsSL https://sh.rustup.rs | CARGO_HOME=/opt/cargo sh -s -- -y --no-modify-path \
       --profile minimal --default-toolchain "${RUST_VERSION}" --component rustfmt,clippy \
    && chmod -R a+rX /opt/rustup /opt/cargo

# Java (Eclipse Temurin), Maven, Kotlin.
RUN mkdir -p /opt/java && curl -fsSL \
       "https://api.adoptium.net/v3/binary/version/${JAVA_VERSION/+/%2B}/linux/x64/jdk/hotspot/normal/eclipse" \
       | tar xz -C /opt/java --strip-components=1 \
    && mkdir -p /opt/maven && curl -fsSL \
       "https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz" \
       | tar xz -C /opt/maven --strip-components=1 \
    && curl -fsSL -o /tmp/kotlin.zip \
       "https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN_VERSION}/kotlin-compiler-${KOTLIN_VERSION}.zip" \
    && unzip -q /tmp/kotlin.zip -d /opt && rm /tmp/kotlin.zip

# .NET SDK (Microsoft's installer; the distro feed trails the SDK patches).
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && bash /tmp/dotnet-install.sh --version "${DOTNET_SDK_VERSION}" --install-dir /opt/dotnet \
    && rm /tmp/dotnet-install.sh

# Haskell (GHC via ghcup).
RUN curl -fsSL -o /usr/local/bin/ghcup https://downloads.haskell.org/~ghcup/x86_64-linux-ghcup \
    && chmod +x /usr/local/bin/ghcup \
    && GHCUP_INSTALL_BASE_PREFIX=/opt ghcup install ghc "${GHC_VERSION}" --set \
    && GHCUP_INSTALL_BASE_PREFIX=/opt ghcup gc --cache --tmpdirs \
    && chmod -R a+rX /opt/.ghcup

# Common Lisp (SBCL binary release).
RUN curl -fsSL "https://downloads.sourceforge.net/project/sbcl/sbcl/${SBCL_VERSION}/sbcl-${SBCL_VERSION}-x86-64-linux-binary.tar.bz2" \
       | tar xj -C /tmp \
    && cd "/tmp/sbcl-${SBCL_VERSION}-x86-64-linux" && INSTALL_ROOT=/opt/sbcl sh install.sh >/dev/null \
    && rm -rf "/tmp/sbcl-${SBCL_VERSION}-x86-64-linux"

# Source-built languages.
COPY --from=ruby /opt/ruby /opt/ruby
COPY --from=php /opt/php /opt/php
COPY --from=perl /opt/perl /opt/perl
COPY --from=small /opt/lua /opt/lua
COPY --from=small /opt/nasm /opt/nasm

ENV JAVA_HOME=/opt/java DOTNET_ROOT=/opt/dotnet SBCL_HOME=/opt/sbcl/lib/sbcl \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_WORKLOAD_INTEGRITY_CHECK=1 DISPLAY=:0 \
    PATH=/home/runner/.local/bin:/home/runner/.cargo/bin:/opt/cargo/bin:/usr/local/go/bin:/opt/node/bin:/opt/java/bin:/opt/maven/bin:/opt/kotlinc/bin:/opt/dotnet:/opt/.ghcup/bin:/opt/sbcl/bin:/opt/ruby/bin:/opt/php/bin:/opt/perl/bin:/opt/lua/bin:/opt/nasm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Login shells (the console and shell run `bash -l`) reset PATH from
# /etc/profile, so publish the same PATH there.
RUN printf 'export PATH="%s"\nexport JAVA_HOME=%s DOTNET_ROOT=%s SBCL_HOME=%s RUSTUP_HOME=%s\n' \
       "$PATH" "$JAVA_HOME" "$DOTNET_ROOT" "$SBCL_HOME" "$RUSTUP_HOME" > /etc/profile.d/00-repl-toolchains.sh

# Language servers for editor intellisense (one installer per server).
COPY lsp-install/ /tmp/lsp-install/
RUN set -e; for f in /tmp/lsp-install/*.sh; do echo "== $f"; bash -euo pipefail "$f"; done; rm -rf /tmp/lsp-install

# Every toolchain must actually run; fail the build otherwise.
COPY versions.sh /usr/local/bin/repl-versions
RUN chmod +x /usr/local/bin/repl-versions && repl-versions

# The unprivileged user code runs as (uid 1000 matches the host data dir owner)
RUN (userdel -r ubuntu 2>/dev/null || true) \
    && useradd -m -u 1000 -s /bin/bash runner \
    && mkdir -p /home/runner/app && chown -R runner:runner /home/runner \
    && echo 'export PS1="\[\e[1;32m\]~/\W\[\e[0m\]$ "' >> /home/runner/.bashrc

# In-container agent (PTY websockets, run manager, port discovery)
COPY agent/ /opt/replagent/
RUN chmod +x /opt/replagent/entrypoint.sh

USER runner
WORKDIR /home/runner/app
EXPOSE 8008
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/replagent/entrypoint.sh"]
