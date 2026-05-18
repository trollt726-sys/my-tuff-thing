# Use a slim, modern Node.js base image
FROM node:20-slim

# Install light git/curl system utilities
RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create and set up a non-root user with UID 1000 (Required by Hugging Face)
RUN useradd -m -u 1000 user
WORKDIR /app

# Copy package config and install production dependencies
COPY --chown=user:user package.json package-lock.json* ./
RUN npm install --production

# Copy the rest of the project files
COPY --chown=user:user . .

# Set up runtime permissions
USER user

# Hugging Face default port bindings
EXPOSE 7860
ENV PORT=7860

# Run the Discord bot
CMD ["node", "bot.js"]
