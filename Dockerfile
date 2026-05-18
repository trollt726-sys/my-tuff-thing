# Use a slim, modern Node.js base image
FROM node:20-slim

# Install light git/curl system utilities
RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*


# Create /app and set ownership to node user
RUN mkdir -p /app && chown -R node:node /app

# Use the existing 'node' user (UID 1000) from the base image
WORKDIR /app

# Copy package config and install production dependencies
COPY --chown=node:node package.json package-lock.json* ./
RUN npm install --production

# Copy the rest of the project files
COPY --chown=node:node . .

# Run as non-root user
USER node

# Railway provides PORT automatically
EXPOSE 7860
ENV PORT=7860

# Run the Discord bot
CMD ["node", "bot.js"]
