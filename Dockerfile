# Production Dockerfile for Independent Music Download Agent
FROM node:20-bookworm-slim

# Install Chromium and system dependencies required for Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-symbola \
    dumb-init \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Environment variables for Chromium & Node
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=5000 \
    HOST=0.0.0.0

WORKDIR /app

# Copy root and client package definitions
COPY package*.json ./
COPY client/package*.json ./client/

# Install dependencies for server and client
RUN npm ci --omit=dev && \
    npm --prefix client ci

# Copy application source code
COPY server ./server
COPY client ./client

# Build client React application
RUN npm --prefix client run build && \
    rm -rf client/node_modules

# Ensure downloads directory exists with correct permissions
RUN mkdir -p /app/downloads && chown -R node:node /app

# Switch to unprivileged user
USER node

EXPOSE 5000

# Use dumb-init to properly forward signals and reap zombie browser processes
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server/index.js"]
