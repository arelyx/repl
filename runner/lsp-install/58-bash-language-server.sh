# Bash: bash-language-server, with ShellCheck for diagnostics.
BASH_LS_VERSION=5.8.1
SHELLCHECK_VERSION=0.11.0
npm install -g --no-fund --no-audit "bash-language-server@${BASH_LS_VERSION}"
curl -fsSL "https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.xz" \
  | tar xJ -C /tmp
install -m 755 "/tmp/shellcheck-v${SHELLCHECK_VERSION}/shellcheck" /usr/local/bin/shellcheck
rm -rf "/tmp/shellcheck-v${SHELLCHECK_VERSION}"
shellcheck --version
