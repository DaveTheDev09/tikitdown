#!/bin/bash
# TikItDown VPS Deployment Script
# Run this on your Hetzner VPS after cloning the repo

echo "=== TikItDown Setup ==="

# Install Docker (for Cobalt)
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker $USER
fi

# Install Docker Compose
if ! command -v docker-compose &> /dev/null; then
    echo "Installing Docker Compose..."
    sudo apt-get install -y docker-compose-plugin
fi

# Install Node.js 18+ if not present
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Install PM2 globally
sudo npm install -g pm2

# Install dependencies
echo "Installing npm dependencies..."
npm install

# Install ffmpeg (for video processing)
echo "Installing ffmpeg..."
sudo apt-get update && sudo apt-get install -y ffmpeg

# Start Cobalt (handles TikTok downloads)
echo "Starting Cobalt..."
docker compose up -d cobalt

# Wait for Cobalt to start
echo "Waiting for Cobalt to start..."
sleep 5

# Verify Cobalt is running
if docker compose ps cobalt | grep -q "Up"; then
    echo "Cobalt is running on port 9000"
else
    echo "WARNING: Cobalt failed to start. Check: docker compose logs cobalt"
fi

# Verify installations
echo "=== Verification ==="
node --version
npm --version
docker --version
ffmpeg -version | head -1

echo ""
echo "=== Setup Complete ==="
echo "Cobalt API: http://localhost:9000"
echo "Main app: http://localhost:3000"
echo ""
echo "Start with: pm2 start server.js --name tikitdown"
echo "Check logs: pm2 logs tikitdown"
