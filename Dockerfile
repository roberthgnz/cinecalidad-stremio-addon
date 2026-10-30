# Use the official Node.js runtime as parent image
FROM node:22-alpine

# Set the working directory in the container
WORKDIR /app

# Install pnpm globally (use version 9 to match lockfile)
RUN npm install -g pnpm@9

# Copy package.json and pnpm-lock.yaml (if available)
COPY package.json ./
COPY pnpm-lock.yaml* ./

# Install dependencies with fallback for lockfile compatibility
RUN if [ -f pnpm-lock.yaml ]; then \
        pnpm install --frozen-lockfile --prod; \
    else \
        pnpm install --prod; \
    fi

# Copy the rest of the application code
COPY . .

# Create necessary directories and set permissions
RUN mkdir -p data && \
    chown -R node:node /app

# Switch to non-root user
USER node

# Expose the port the app runs on
EXPOSE 7000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:7000/', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start the application
CMD ["pnpm", "start"]
