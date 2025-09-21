FROM node:18-alpine
WORKDIR /app

# ffmpeg を追加
RUN apk add --no-cache ffmpeg

# 依存インストール
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ソース配置
COPY . .

EXPOSE 8080
CMD ["npm","start"]