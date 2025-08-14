FROM node:20-bullseye

# FFmpeg + công cụ tải (curl) để lấy yt-dlp binary
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Tải yt-dlp (binary, không cần python)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
     -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

# Cài deps theo lockfile nếu có
COPY package*.json ./
RUN npm ci --omit=dev

# Copy code
COPY . .

ENV NODE_ENV=production

# Start bot
CMD ["node", "index.js"]
