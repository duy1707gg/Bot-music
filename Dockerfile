FROM node:20-bullseye

# Cài FFmpeg + Python (yt-dlp-exec cần python trong PATH)
RUN apt-get update \
&& apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
&& ln -sf /usr/bin/python3 /usr/bin/python \
&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cài deps theo lockfile nếu có
COPY package*.json ./
RUN npm ci --omit=dev

# Copy code
COPY . .

ENV NODE_ENV=production

# Start bot
CMD ["node", "index.js"]
