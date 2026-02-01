#!/bin/bash
# Local deploy script - bypasses GitHub Actions

set -e

HOST="92.113.31.9"
USER="root"
KEY="$HOME/.ssh/github_ed25519"
REMOTE_DIR="/var/www/polymarket-scanner"

echo "🚀 Deploying to $HOST..."

# Sync files
rsync -avz --delete \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.env' \
    --exclude='.env.local' \
    --exclude='reports/*' \
    --exclude='logs/*' \
    --exclude='*.session.json' \
    -e "ssh -i $KEY -o StrictHostKeyChecking=no" \
    ./ $USER@$HOST:$REMOTE_DIR/

# Build & Restart on server
ssh -i $KEY -o StrictHostKeyChecking=no $USER@$HOST << 'ENDSSH'
cd /var/www/polymarket-scanner
npm install
npm run build
pm2 restart ecosystem.config.js --env production || pm2 start ecosystem.config.js --env production
pm2 save
echo "✅ Deployment complete!"
ENDSSH

echo "🌐 https://fluessiger.de"
