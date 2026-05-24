# Base Node image
FROM node:20-alpine

# Install system dependencies needed for Prisma on Alpine
RUN apk add --no-cache openssl libc6-compat

# Set working directory
WORKDIR /app

# Copy dependency configs
COPY package*.json ./

# Install packages
RUN npm install

# Copy source code and prisma schema
COPY tsconfig.json ./
COPY prisma ./prisma/
COPY src ./src/

# Generate Prisma Client and compile TypeScript
RUN npx prisma generate
RUN npm run build

# Expose backend port
EXPOSE 5001

# Command to execute (push schema directly and start server)
CMD ["sh", "-c", "npx prisma db push && npm run start"]
