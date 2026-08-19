#!/bin/bash
# TikItDown VPS Deployment Script
# Run this on your Hetzner VPS after cloning the repo

echo "=== TikItDown Setup ==="

# Install Node.js 18+ if not present
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Install dependencies
echo "Installing npm dependencies..."
npm install

# Install yt-dlp (primary TikTok scraper)
echo "Installing yt-dlp..."
pip3 install yt-dlp || sudo pip3 install yt-dlp

# Install ffmpeg (for video processing)
echo "Installing ffmpeg..."
sudo apt-get update && sudo apt-get install -y ffmpeg

# Verify installations
echo "=== Verification ==="
node --version
npm --version
yt-dlp --version
ffmpeg -version | head -1

echo ""
echo "=== Setup Complete ==="
echo "Start the server: npm start"
echo "Or with PM2: pm2 start server.js --name tikitdown"
