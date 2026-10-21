# hijackbench CLI. Node runs the TypeScript sources directly: no build step.

FROM node:24-slim AS deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/cli/package.json apps/cli/
RUN pnpm install --frozen-lockfile --prod

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
	HIJACKBENCH_DATA=/data
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/core/node_modules packages/core/node_modules
COPY --from=deps /app/apps/cli/node_modules apps/cli/node_modules
COPY package.json ./
COPY packages/core/package.json packages/core/
COPY packages/core/src packages/core/src
COPY apps/cli/package.json apps/cli/
COPY apps/cli/src apps/cli/src
COPY campaigns campaigns
RUN mkdir /data && chown node:node /data \
	&& ln -s /app/apps/cli/src/index.ts /usr/local/bin/hijackbench
USER node
VOLUME /data
ENTRYPOINT ["hijackbench"]
CMD ["--help"]
