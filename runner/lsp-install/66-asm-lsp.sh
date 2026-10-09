# Assembly (NASM): asm-lsp — x86/x86-64 instruction, register and NASM
# directive completion, hover docs and signature help. Diagnostics come from
# compiler_ls.py running nasm on every edit (asm-lsp's own only run on save,
# carry no severity and leave a .o next to the source), so they're off here.
ASM_LSP_VERSION=0.10.1
tmp="$(mktemp -d)"
curl -fsSL "https://github.com/bergercookie/asm-lsp/releases/download/v${ASM_LSP_VERSION}/asm-lsp-x86_64-unknown-linux-gnu.tar.gz" \
  | tar xz -C "$tmp"
install -m 755 "$(find "$tmp" -type f -name asm-lsp | head -1)" /usr/local/bin/asm-lsp
rm -rf "$tmp"

# Global config, found through XDG_CONFIG_HOME (set in the lsp spec). A
# project's own .asm-lsp.toml still takes precedence.
mkdir -p /opt/lsp/asm-lsp/asm-lsp
cat > /opt/lsp/asm-lsp/asm-lsp/.asm-lsp.toml <<TOML
[default_config]
version = "${ASM_LSP_VERSION}"
assembler = "nasm"
instruction_set = "x86/x86-64"

[default_config.opts]
compiler = "nasm"
compile_flags_txt = ["-f", "elf64", "-o", "/dev/null"]
diagnostics = false
default_diagnostics = false
TOML
chmod -R a+rX /opt/lsp/asm-lsp
asm-lsp version
