FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV CODEGRAPH_TELEMETRY=0
ENV DO_NOT_TRACK=1

WORKDIR /workspace

ARG CODEGRAPH_VERSION=1.4.1
RUN npm install -g @colbymchenry/codegraph@${CODEGRAPH_VERSION} && npm cache clean --force

ENTRYPOINT ["codegraph"]
CMD ["serve", "--mcp"]
