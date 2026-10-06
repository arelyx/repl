# "polyglot" — one fat image with every toolchain, in the spirit of Replit's
# 2020-era "polygott" image. Every repl container runs this image.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC

# Core + compilers + interpreters from the distro
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg git sudo less nano vim-tiny unzip zip xz-utils \
      procps iproute2 net-tools lsof htop tree jq sqlite3 locales tini \
      build-essential gcc g++ gdb clang make cmake pkg-config \
      python3 python3-pip python3-venv python3-dev python3-tk idle-python3.12 \
      openjdk-21-jdk maven \
      golang-go \
      rustc cargo \
      ruby-full \
      php-cli php-sqlite3 php-mbstring php-xml php-curl \
      lua5.4 perl \
      ghc \
      r-base-core \
      dotnet-sdk-8.0 \
      nasm fpc gfortran guile-3.0 sbcl \
      xvfb x11vnc fluxbox novnc websockify xterm x11-apps fonts-dejavu \
    && rm -rf /var/lib/apt/lists/*

# Modern Node.js (distro node is too old for Vite / Next)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g typescript tsx ts-node nodemon \
    && rm -rf /var/lib/apt/lists/*

# Kotlin compiler
RUN curl -fsSL -o /tmp/kotlin.zip https://github.com/JetBrains/kotlin/releases/download/v2.0.21/kotlin-compiler-2.0.21.zip \
    && unzip -q /tmp/kotlin.zip -d /opt && rm /tmp/kotlin.zip \
    && ln -s /opt/kotlinc/bin/kotlinc /usr/local/bin/kotlinc && ln -s /opt/kotlinc/bin/kotlin /usr/local/bin/kotlin

# Common Python packages so ad-hoc web servers start instantly
RUN pip3 install --break-system-packages --no-cache-dir \
      flask fastapi "uvicorn[standard]" django requests numpy pygame aiohttp

# The unprivileged user code runs as (uid 1000 matches the host data dir owner)
RUN (userdel -r ubuntu 2>/dev/null || true) \
    && useradd -m -u 1000 -s /bin/bash runner \
    && mkdir -p /home/runner/app && chown -R runner:runner /home/runner \
    && echo 'export PS1="\[\e[1;32m\]~/\W\[\e[0m\]$ "' >> /home/runner/.bashrc

ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DISPLAY=:0 \
    PATH=/home/runner/.local/bin:/home/runner/.cargo/bin:$PATH

# In-container agent (PTY websockets, run manager, port discovery)
COPY agent/ /opt/replagent/
RUN chmod +x /opt/replagent/entrypoint.sh

USER runner
WORKDIR /home/runner/app
EXPOSE 8008 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/replagent/entrypoint.sh"]
