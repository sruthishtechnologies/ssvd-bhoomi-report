FROM node:20-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY src/package*.json ./
RUN npm install --omit=dev

COPY src/ ./

EXPOSE 3000

CMD ["npm", "start"]
