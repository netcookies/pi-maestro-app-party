# Maestro Mobile Host — Docker 镜像
# 构建：docker build -t maestro-mobile-host .
# 运行：
#   docker run -d --name maestro-mobile \
#     -p 4739:4739 \
#     -v /path/to/projects:/workspace \
#     -e MAESTRO_MOBILE_PROJECT_ROOT=/workspace \
#     -e MAESTRO_MOBILE_TOKEN=your-secret \
#     maestro-mobile-host

FROM node:22-alpine

WORKDIR /app

# 安装 pnpm
RUN corepack enable

# 复制工作区清单
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/host ./apps/host

# 安装依赖（仅 host + shared）
RUN pnpm install --filter @maestro-mobile/host --frozen-lockfile

# 构建
RUN pnpm --filter @maestro-mobile/shared build \
    && pnpm --filter @maestro-mobile/host build

# 运行时
EXPOSE 4739
CMD ["node", "apps/host/dist/cli.js", "--host", "0.0.0.0", "--port", "4739"]
