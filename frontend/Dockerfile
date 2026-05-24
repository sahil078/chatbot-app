# Base Node image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy dependency configs
COPY package*.json ./

# Install packages
RUN npm install

# Copy source code
COPY tsconfig.json ./
COPY src ./src/

# Build Next.js app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Expose port
EXPOSE 3000

# Start server
CMD ["npm", "run", "start"]
