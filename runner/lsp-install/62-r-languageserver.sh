# R: the CRAN languageserver package (lintr-based diagnostics), installed
# into the site library so every user can load it.
R_LANGUAGESERVER_VERSION=0.3.20
# fs (a dependency) links libuv; build its bundled copy instead of adding a -dev package.
export USE_BUNDLED_LIBUV=1 MAKEFLAGS="-j$(nproc)"
Rscript -e "install.packages('remotes', lib='/usr/local/lib/R/site-library', repos='https://cloud.r-project.org', Ncpus=$(nproc))" \
        -e "remotes::install_version('languageserver', version='${R_LANGUAGESERVER_VERSION}', lib='/usr/local/lib/R/site-library', repos='https://cloud.r-project.org', upgrade='never', Ncpus=$(nproc))"
find /usr/local/lib/R/site-library ! -type l \( ! -perm -o+r -o -perm -u+x ! -perm -o+x \) -exec chmod a+rX {} +
Rscript -e "stopifnot(packageVersion('languageserver') == '${R_LANGUAGESERVER_VERSION}')"
