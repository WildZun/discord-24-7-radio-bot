FROM node:22-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data

USER node

ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV DATABASE_PATH=/app/data/radio-bot.sqlite

CMD ["npm", "start"]
