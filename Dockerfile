FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
# Node sizes its heap from the machine's memory; on a small server (512 MB) that is too little for the
# TypeScript build. Let it grow into swap. Only the build uses this, not the running API.
ARG BUILD_MEMORY_MB=1536
RUN NODE_OPTIONS=--max-old-space-size=$BUILD_MEMORY_MB npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
USER node
EXPOSE 3000
# Migrations are applied explicitly (npx prisma migrate deploy) as a release step, not on boot.
CMD ["node", "dist/main"]
