# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:20.19.6-alpine3.21
ARG PNPM_VERSION=10.30.2
ARG NPM_REGISTRY=https://registry.npmjs.org/

FROM ${NODE_IMAGE} AS pnpm-base

ARG PNPM_VERSION
ARG NPM_REGISTRY

WORKDIR /app

RUN corepack enable \
    && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
    && pnpm config set registry "${NPM_REGISTRY}" \
    && pnpm config set store-dir /pnpm/store \
    && pnpm --version

# 依赖层只受清单和锁文件影响，普通源码修改不会重新安装依赖。
FROM pnpm-base AS workspace-deps

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY core/package.json ./core/
COPY web/package.json ./web/

RUN --mount=type=cache,id=qq-farm-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

# Web 与 Core 分阶段构建，单侧源码变化可复用另一侧产物缓存。
FROM workspace-deps AS web-builder

COPY web ./web
RUN pnpm -C web build

FROM workspace-deps AS core-builder

COPY core ./core
RUN pnpm -C core build:runtime

# 生产依赖不受应用源码变化影响。
FROM pnpm-base AS prod-deps

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY core/package.json ./core/
COPY web/package.json ./web/

RUN --mount=type=cache,id=qq-farm-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm -C core install --prod --frozen-lockfile

# ==========================================
FROM ${NODE_IMAGE} AS runner

WORKDIR /app/core

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai

RUN apk add --no-cache tzdata \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && apk del tzdata

COPY --from=prod-deps /app/node_modules ../node_modules/
COPY --from=prod-deps /app/core/node_modules ./node_modules/
COPY --from=prod-deps /app/package.json ../package.json
COPY --from=prod-deps /app/core/package.json ./package.json

COPY --from=core-builder /app/core/build ./build
COPY --from=core-builder /app/core/src/activity-data ./src/activity-data
COPY --from=core-builder /app/core/src/gameConfig ./src/gameConfig
COPY --from=core-builder /app/core/src/proto ./src/proto
COPY --from=core-builder /app/core/src/utils/tsdk.wasm ./src/utils/tsdk.wasm
COPY --from=core-builder /app/core/resources/game-data ./resources/game-data
COPY --from=core-builder /app/core/share.txt ./share.txt
COPY --from=web-builder /app/web/dist ../web/dist

RUN mkdir -p data/logs && chmod -R 755 data

VOLUME ["/app/core/data"]

EXPOSE 3007

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:3007/api/game-version || exit 1

CMD ["node", "build/client.js"]
