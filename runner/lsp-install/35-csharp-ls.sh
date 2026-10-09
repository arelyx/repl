# C#: csharp-ls (Roslyn-based), installed as a .NET tool into a shared tool
# path so the repl user can run it.
CSHARP_LS_VERSION=0.28.0
dir=/opt/lsp/csharp-ls
# Keep the CLI's home and NuGet scratch files out of the image's /tmp.
scratch="$(mktemp -d)"
export DOTNET_CLI_HOME="$scratch" TMPDIR="$scratch" NUGET_PACKAGES="$scratch/packages"
dotnet tool install csharp-ls --version "${CSHARP_LS_VERSION}" --tool-path "$dir"
rm -rf "$scratch"
chmod -R a+rX "$dir"
ln -sf "$dir/csharp-ls" /usr/local/bin/csharp-ls
csharp-ls --version
