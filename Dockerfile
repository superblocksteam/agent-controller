# Deploy image
FROM node:16-bullseye-slim

RUN set -ex; \
  apt-get update && \
  apt-get install -yqq dumb-init --no-install-recommends && \
  rm -rf /var/lib/apt/lists/*

ENV NODE_ENV production
USER node
WORKDIR /usr/app

COPY node_modules /usr/app/agent/node_modules
COPY dist /usr/app/agent/dist
COPY package.json /usr/app/agent/
WORKDIR /usr/app/agent/dist

ENV SUPERBLOCKS_AGENT_VERSION=0.2389.0
ENV SUPERBLOCKS_AGENT_VERSION_EXTERNAL=0.2389.0

CMD ["dumb-init", "node", "agent.js"]
