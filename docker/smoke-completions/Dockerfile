# Smoke-test image for `codegraph completions` output. Runs the actual
# generated zsh/bash/fish scripts under their real shells against pinned
# versions. Image is intentionally minimal — no extras the test doesn't
# need. See README.md for what's verified and what isn't.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      zsh \
      bash \
      bash-completion \
      fish \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY run.sh test-bash.sh test-fish.sh test-zsh.sh /smoke/
RUN chmod +x /smoke/*.sh

WORKDIR /smoke
ENTRYPOINT ["/smoke/run.sh"]
