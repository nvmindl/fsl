#!/bin/bash

# FaselHD Stremio Addon Quick Start Script

# Add Node.js to PATH if needed
export PATH="/home/deck/.local/node-v20.11.1-linux-x64/bin:$PATH"

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "================================================================"
echo "FaselHD Stremio Addon"
echo "================================================================"
echo ""

# Check if node_modules exists
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo "📦 Installing dependencies..."
    cd "$SCRIPT_DIR"
    npm install
    echo ""
fi

# Parse arguments
PORT=${1:-27828}

echo "🚀 Starting FaselHD Stremio Addon..."
echo "   Port: $PORT"
echo "   URL: http://localhost:$PORT/manifest.json"
echo ""
echo "⏳ Loading... Press Ctrl+C to stop"
echo ""

cd "$SCRIPT_DIR"
PORT=$PORT node addon.js
