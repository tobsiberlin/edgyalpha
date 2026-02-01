#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Polymarket Alpha Scanner - VPS Setup Script
# ═══════════════════════════════════════════════════════════════
#
# Dieses Script richtet einen frischen Ubuntu VPS ein für:
# - Node.js 20 LTS
# - PM2 Process Manager
# - Nginx Reverse Proxy
# - Let's Encrypt SSL
# - Fail2ban Security
# - UFW Firewall
#
# Verwendung: sudo bash setup-vps.sh
# ═══════════════════════════════════════════════════════════════

set -e

# Farben
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║     POLYMARKET ALPHA SCANNER - VPS SETUP                      ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Prüfen ob als root ausgeführt
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Bitte als root ausführen: sudo bash setup-vps.sh${NC}"
    exit 1
fi

# Variablen (werden als Parameter übergeben oder interaktiv abgefragt)
DOMAIN="${1:-fluessiger.de}"
EMAIL="${2:-admin@fluessiger.de}"
WEB_USER="${3:-tobsi}"
WEB_PASS="${4:-}"
DEPLOY_USER="deployer"

echo -e "${YELLOW}Konfiguration:${NC}"
echo "  Domain: $DOMAIN"
echo "  Email: $EMAIL"
echo "  Web-User: $WEB_USER"
echo ""

# ═══════════════════════════════════════════════════════════════
# 1. System Update
# ═══════════════════════════════════════════════════════════════
echo -e "${GREEN}[1/10] System Update...${NC}"
apt update && apt upgrade -y

# ═══════════════════════════════════════════════════════════════
# 2. Deployer User erstellen
# ═══════════════════════════════════════════════════════════════
echo -e "${GREEN}[2/10] Deployer User erstellen...${NC}"
if ! id "$DEPLOY_USER" &>/dev/null; then
    adduser --disabled-password --gecos "" $DEPLOY_USER
    usermod -aG sudo $DEPLOY_USER
    echo "$DEPLOY_USER ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/$DEPLOY_USER
fi

# SSH-Verzeichnis für deployer
mkdir -p /home/$DEPLOY_USER/.ssh
chmod 700 /home/$DEPLOY_USER/.ssh
touch /home/$DEPLOY_USER/.ssh/authorized_keys
chmod 600 /home/$DEPLOY_USER/.ssh/authorized_keys
chown -R $DEPLOY_USER:$DEPLOY_USER /home/$DEPLOY_USER/.ssh

echo -e "${YELLOW}[!] Füge deinen SSH Public Key hinzu:${NC}"
echo "    /home/$DEPLOY_USER/.ssh/authorized_keys"

# ═══════════════════════════════════════════════════════════════
# 3. SSH Hardening
# ═══════════════════════════════════════════════════════════════
echo -e "${GREEN}[3/10] SSH Hardening...${NC}"

# Backup der originalen sshd_config
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup

# SSH Hardening Einstellungen
cat > /etc/ssh/sshd_config.d/hardening.conf << EOF
# SSH Hardening
PermitRootLogin prohibit-password
PasswordAuthentication no
PubkeyAuthentication yes
AllowUsers $DEPLOY_USER
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
X11Forwarding no
EOF

systemctl restart sshd

# ═══════════════════════════════════════════════════════════════
# 4. Firewall (UFW)
# ═══════════════════════════════════════════════════════════════
echo -e "${GREEN}[4/10] Firewall einrichten...${NC}"
apt install ufw -y
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
echo "y" | ufw enable

# ═══════════════════════════════════════════════════════════════
# 5. Fail2ban
# ═══════════════════════════════════════════════════════════════
echo -e "${GREEN}[5/10] Fail2ban installieren...${NC}"
apt install fail2ban -y

cat > /etc/fail2ban/jail.local << EOF
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 24h
EOF

systemctl enable fail2ban
systemctl restart fail2ban

# ═══════════════════════════════════════════════════════════════
# 6. Node.js 20 LTS
# ═══════════════════════════════════════════════════════════════
echo -e "${GREEN}[6/10] Node.js 20 LTS installieren...${NC}"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install nodejs -y

# PM2
npm install -g pm2
pm2 startup systemd -u $DEPLOY_USER --hp /home/$DEPLOY_USER

# ═══════════════════════════════════════════════════════════════
# 7. Nginx
# ═══════════════════════════════════════════════════════════════
echo -e "${GREEN}[7/10] Nginx installieren...${NC}"
apt install nginx apache2-utils -y

# Nginx Konfiguration
cat > /etc/nginx/sites-available/polymarket-scanner << EOF
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;

    location / {
        return 301 https://\$server_name\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN www.$DOMAIN;

    # SSL wird von Certbot konfiguriert

    # Basic Auth
    auth_basic "Alpha Scanner - Zugang beschraenkt";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 86400;
    }

    # Health Check ohne Auth
    location /health {
        auth_basic off;
        proxy_pass http://127.0.0.1:3000/health;
    }

    # WebSocket Support
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
EOF

# Aktivieren
ln -sf /etc/nginx/sites-available/polymarket-scanner /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# ═══════════════════════════════════════════════════════════════
# 8. SSL mit Let's Encrypt
# ═══════════════════════════════════════════════════════════════
echo -e "${GREEN}[8/10] SSL Zertifikat einrichten...${NC}"
apt install certbot python3-certbot-nginx -y

# Erst Nginx ohne SSL testen
nginx -t && systemctl reload nginx

# SSL Zertifikat holen
certbot --nginx -d $DOMAIN -d www.$DOMAIN --non-interactive --agree-tos -m $EMAIL || {
    echo -e "${YELLOW}SSL-Zertifikat konnte nicht erstellt werden.${NC}"
    echo "Bitte stelle sicher, dass die Domain auf diesen Server zeigt."
}

# ═══════════════════════════════════════════════════════════════
# 9. Web-Interface Passwort
# ═══════════════════════════════════════════════════════════════
echo -e "${GREEN}[9/10] Web-Interface Passwort setzen...${NC}"
if [ -n "$WEB_PASS" ]; then
    htpasswd -bc /etc/nginx/.htpasswd "$WEB_USER" "$WEB_PASS"
else
    echo -e "${YELLOW}Bitte Web-Passwort eingeben:${NC}"
    htpasswd -c /etc/nginx/.htpasswd "$WEB_USER"
fi
chmod 640 /etc/nginx/.htpasswd
chown root:www-data /etc/nginx/.htpasswd

nginx -t && systemctl reload nginx

# ═══════════════════════════════════════════════════════════════
# 10. Projekt-Verzeichnis
# ═══════════════════════════════════════════════════════════════
echo -e "${GREEN}[10/10] Projekt-Verzeichnis erstellen...${NC}"
mkdir -p /var/www/polymarket-scanner
mkdir -p /var/log/pm2
chown -R $DEPLOY_USER:$DEPLOY_USER /var/www/polymarket-scanner
chown -R $DEPLOY_USER:$DEPLOY_USER /var/log/pm2

# Automatische Security Updates
apt install unattended-upgrades -y
dpkg-reconfigure -plow unattended-upgrades

# ═══════════════════════════════════════════════════════════════
# Fertig!
# ═══════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     ✅ VPS SETUP ABGESCHLOSSEN                                ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Nächste Schritte:${NC}"
echo ""
echo "1. SSH Key für GitHub Actions hinzufügen:"
echo "   /home/$DEPLOY_USER/.ssh/authorized_keys"
echo ""
echo "2. .env.local auf dem VPS erstellen:"
echo "   /var/www/polymarket-scanner/.env.local"
echo ""
echo "3. GitHub Secrets konfigurieren:"
echo "   - VPS_HOST=$DOMAIN"
echo "   - VPS_USER=$DEPLOY_USER"
echo "   - VPS_SSH_KEY=<private-key>"
echo ""
echo "4. Push zu main Branch für Auto-Deploy"
echo ""
echo -e "${GREEN}Dashboard: https://$DOMAIN${NC}"
echo ""
