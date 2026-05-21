# Smoke-test image for `codegraph completions` output. Runs the actual
# generated zsh/bash/fish/powershell scripts under their real shells
# against pinned versions. Image is intentionally minimal — no extras
# the test doesn't need. See README.md for what's verified and what isn't.
FROM node:22-bookworm-slim

# pwsh isn't in Microsoft's Debian apt repo for arm64, but the GitHub
# release tarballs are multi-arch. Fetch the right one based on the
# image's architecture so the smoke runs natively on Apple Silicon and
# x86_64 alike. Pinned to a specific PS version for build determinism.
ARG POWERSHELL_VERSION=7.6.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      zsh \
      bash \
      bash-completion \
      fish \
      ca-certificates \
      curl \
      libicu72 \
 && arch=$(dpkg --print-architecture) \
 && case "$arch" in \
      amd64) ps_arch=x64 ;; \
      arm64) ps_arch=arm64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac \
 && mkdir -p /opt/microsoft/powershell/7 \
 && curl -fsSL -o /tmp/pwsh.tgz \
      "https://github.com/PowerShell/PowerShell/releases/download/v${POWERSHELL_VERSION}/powershell-${POWERSHELL_VERSION}-linux-${ps_arch}.tar.gz" \
 && tar -xzf /tmp/pwsh.tgz -C /opt/microsoft/powershell/7 \
 && chmod +x /opt/microsoft/powershell/7/pwsh \
 && ln -s /opt/microsoft/powershell/7/pwsh /usr/bin/pwsh \
 && rm /tmp/pwsh.tgz \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY run.sh test-bash.sh test-fish.sh test-zsh.sh test-powershell.sh test-zsh-ohmyzsh.sh /smoke/
RUN chmod +x /smoke/*.sh

WORKDIR /smoke
ENTRYPOINT ["/smoke/run.sh"]
