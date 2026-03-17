#!/bin/bash
# FaselHD Addon - Oracle Cloud VM Setup Script
# Run this on your Oracle Cloud free-tier VM (Ubuntu)

set -e

echo "=== Installing Node.js 20 ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "=== Cloning addon ==="
cd ~
git clone https://github.com/nvmindl/fsl.git
cd fsl
npm install

echo "=== Setting up systemd service ==="
sudo tee /etc/systemd/system/faselhdx.service > /dev/null <<EOF
[Unit]
Description=FaselHD Stremio Addon
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME/fsl
ExecStart=/usr/bin/node addon.js
Restart=always
RestartSec=5
Environment=PORT=27828

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable faselhdx
sudo systemctl start faselhdx

echo "=== Opening firewall port ==="
sudo iptables -I INPUT -p tcp --dport 27828 -j ACCEPT
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save

echo ""
echo "=== DONE ==="
echo "Addon running on port 27828"
echo "Your manifest URL: http://$(curl -s ifconfig.me):27828/manifest.json"
echo ""
echo "Add this URL to Nuvio!"
