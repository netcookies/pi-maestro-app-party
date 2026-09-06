# maestro-mobile — Docker 镜像（看板模式）
#
# 构建：docker build -t maestro-mobile .
#
# 看板模式（推荐）：挂载宿主 ~/.pi 只读，Dashboard/Monitor/usage 全可用，
# 但 open_session / steer_window 的会话接管不可用（容器内无 pi 认证上下文）。
#
#   docker run -d --name maestro-mobile \
#     -p 4739:4739 \
#     -v ~/.pi/agent/sessions:/home/node/.pi/agent/sessions:ro \
#     -v ~/.pi/teammate:/home/node/.pi/teammate:ro \
#     -e MAESTRO_MOBILE_TOKEN=your-secret \
#     maestro-mobile
#
# 完整模式（进阶）：额外挂载 ~/.pi/agent 读写 + 容器内安装 pi，才能在容器里
# 打开/接管会话。见 docs/deploy.md「完整模式」。

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/host ./apps/host
RUN pnpm install --filter maestro-mobile --frozen-lockfile \
    && pnpm --filter maestro-mobile build
# pnpm deploy --legacy 提取 host 的生产依赖 + dist（独立树；v10 需 --legacy 免 injected-workspace 约束）
RUN mkdir -p /host-deploy \
    && pnpm --filter ./apps/host deploy --legacy /host-deploy

# ── 运行时镜像：仅 dist + node_modules，不带 pnpm/工作区 ──
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# 看板模式只读挂载点（宿主 ~/.pi 的两个子目录）
RUN mkdir -p /home/node/.pi/agent/sessions /home/node/.pi/teammate \
    && chown -R node:node /home/node/.pi /app
COPY --from=build /host-deploy ./
USER node
EXPOSE 4739
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MAESTRO_MOBILE_PORT||4739)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/cli.js", "--host", "0.0.0.0", "--port", "4739"]
