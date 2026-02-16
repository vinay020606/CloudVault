# 1. Use official Node.js runtime (Lightweight Alpine version)
FROM node:18-alpine

# 2. Set working directory inside the container
WORKDIR /usr/src/app

# 3. Copy package files first (better caching)
COPY package*.json ./

# 4. Install dependencies
RUN npm install

# 5. Copy the rest of your app code
COPY . .

# 6. Expose the port
EXPOSE 3000

# 7. Start the app
CMD ["node", "server.js"]
