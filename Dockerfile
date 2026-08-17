# Worker image for Fly.io / any container host. No HTTP port — the bot uses
# Telegram long-polling, so nothing needs to be exposed.
FROM node:22-slim

WORKDIR /app

# Install deps first so the layer caches across code changes. tsx is a runtime
# dependency (npm start runs it), so --omit=dev is safe.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["npm", "start"]
