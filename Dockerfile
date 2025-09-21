# Dockerfile（リポジトリ直下）
FROM node:18-alpine

# ffmpeg はビルド時に入れておく（起動時に入れると遅くなる）
RUN apk add --no-cache ffmpeg

WORKDIR /app

# 依存を固定インストール
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# アプリ本体をコピー
COPY . .

ENV NODE_ENV=production
ENV PORT=8080

# Cloud Run のヘルス/ルーティングのためのお作法
EXPOSE 8080

# サーバ起動
CMD ["node","server.js"]
