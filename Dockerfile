# 1. Use official Node.js runtime (Lightweight Alpine version)
FROM node:20-alpine

# 2. Set working directory inside the container
WORKDIR /usr/src/app

# 3. Copy package files first
COPY package*.json ./

# 4. Install dependencies
RUN npm install

# 5. Copy the rest of app code
COPY . .

# 6. Expose gateway port
EXPOSE 3000

# 7. Start the CloudVault gateway server
CMD ["npm", "start"]
