# --- build ---
# Its output is plain JavaScript, so it runs natively even when the image is for another CPU.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- run ---
FROM node:22-bookworm-slim
ENV NODE_ENV=production
# ffmpeg rewrites each finished recording with a duration and a seek index (MediaRecorder files have neither)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY db/migrations ./db/migrations
USER node
EXPOSE 3100
CMD ["node", "dist/server.js"]
