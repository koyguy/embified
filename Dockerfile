FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3002
ENV AUTH_DIR=/data/auth_info
ENV DATA_DIR=/data/store

RUN mkdir -p /data/auth_info /data/store

EXPOSE 3002

CMD ["npm", "start"]
