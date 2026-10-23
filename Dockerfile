# ==========================================
# Stage 1: Build React Client Frontend
# ==========================================
FROM node:20-bookworm-slim AS client-builder

WORKDIR /app/client

# Copy client dependency definitions
COPY client/package*.json ./

# Install all client dependencies including devDependencies (Vite, Rollup, Babel)
RUN npm ci

# Copy client source files and configuration
COPY client/ ./

# Build production bundle into /app/client/dist
RUN npm run build

# ==========================================
# Stage 2: Production Runtime Image
# ==========================================
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

# Environment variables for Chromium & Node production runtime
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=5000 \
    HOST=0.0.0.0

WORKDIR /app

# Copy root server dependency definitions
COPY package*.json ./

# Install only production server dependencies
RUN npm ci --omit=dev

# Copy backend server code
COPY server ./server

# Copy compiled frontend assets from Stage 1 (no client devDependencies in final image)
COPY --from=client-builder /app/client/dist ./client/dist

# Ensure downloads directory exists with correct permissions
RUN mkdir -p /app/downloads && chown -R node:node /app

# Switch to unprivileged user
USER node

EXPOSE 5000

# Use dumb-init to properly forward signals and reap zombie browser processes
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server/index.js"]
