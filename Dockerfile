FROM node:22-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

USER node

ENV FFMPEG_PATH=/usr/bin/ffmpeg

CMD ["npm", "start"]
