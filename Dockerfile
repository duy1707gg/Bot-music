FROM node:20-bullseye

# FFmpeg để phát nhạc
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cài deps theo lockfile nếu có
COPY package*.json ./
RUN npm ci --omit=dev

# Copy code
COPY . .

ENV NODE_ENV=production

# Start bot
CMD ["node", "index.js"]
