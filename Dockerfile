FROM node:20-alpine

# Run as non-root user
RUN addgroup -S cloudvault && adduser -S cloudvault -G cloudvault

WORKDIR /usr/src/app

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy app source
COPY src ./src
COPY public ./public

# Create storage dirs with correct ownership
RUN mkdir -p storage/blocks storage/tenants && \
    chown -R cloudvault:cloudvault /usr/src/app

USER cloudvault

EXPOSE 3000

CMD ["node", "src/server.js"]
