# Language server installers

Each `*.sh` here runs once, as root, at image build time (in name order),
after every language toolchain is installed. One script per language server.
Install into `/opt/lsp/<name>` or a toolchain's own global location, make the
result world-readable, and put a launcher on PATH (`/usr/local/bin`) when the
server isn't already on it. Pin the version (latest stable at the time) in a
variable at the top of the script.

The matching launch entry goes in `runner/agent/lsp/servers.json`; see
`docs/DESIGN.md` (Intellisense) for the format and `runner/agent/lsp_test.py`
for the end-to-end check every server must pass.
