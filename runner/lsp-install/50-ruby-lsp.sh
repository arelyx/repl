# Ruby: ruby-lsp (Shopify). Prism-based syntax diagnostics, completion, hover,
# signature help, with core/stdlib knowledge from RBS.
RUBY_LSP_VERSION=0.26.11
gem install --no-document ruby-lsp -v "${RUBY_LSP_VERSION}"

# Without a Gemfile, ruby-lsp composes a bundle in .ruby-lsp/ and runs
# `bundle install`/`bundle update` against rubygems.org, which fails for the
# repl user (the gem dir is root-owned) and needs the network. Resolve that
# bundle once here from the installed gems and point repls without a Gemfile
# at it; projects with their own Gemfile keep ruby-lsp's normal behaviour.
dir=/opt/lsp/ruby-lsp
mkdir -p "$dir"
cat > "$dir/Gemfile" <<GEMFILE
source "https://rubygems.org"
gem "ruby-lsp", "${RUBY_LSP_VERSION}"
GEMFILE
# No CHECKSUMS section: --local cannot fetch them, and frozen mode rejects empty ones.
(cd "$dir" && BUNDLE_LOCKFILE_CHECKSUMS=false BUNDLE_GEMFILE="$dir/Gemfile" bundle lock --local)
(cd /tmp && BUNDLE_GEMFILE="$dir/Gemfile" BUNDLE_FROZEN=true bundle exec ruby -e "require %q(ruby_lsp/internal)")
cat > /usr/local/bin/replot-ruby-lsp <<'SH'
#!/bin/sh
# ruby-lsp launcher: the image's prebuilt bundle unless the project has a Gemfile.
if [ -z "$BUNDLE_GEMFILE" ] && [ ! -f Gemfile ] && [ ! -f gems.rb ]; then
  export BUNDLE_GEMFILE=/opt/lsp/ruby-lsp/Gemfile BUNDLE_FROZEN=true
  exec bundle exec ruby-lsp "$@"
fi
exec ruby-lsp "$@"
SH
chmod 755 /usr/local/bin/replot-ruby-lsp
# Only touch what lacks the bits: a blanket chmod -R would copy all of
# /opt/ruby (a lower image layer) into this one.
find /opt/ruby "$dir" ! -type l \( ! -perm -o+r -o -perm -u+x ! -perm -o+x \) -exec chmod a+rX {} +
ruby-lsp --version
