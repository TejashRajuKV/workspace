# Deploy Workspace on Google Cloud Compute Engine

This deployment keeps the current architecture intact: Next.js, the Socket.IO collaboration service, and a shared persistent SQLite database on one VM.

## Important free-tier caveat

Google's Compute Engine free tier generally covers one `e2-micro` VM in eligible US regions, up to 30 GB standard persistent disk, and limited outbound transfer. The VM is small and may struggle with Next.js builds or multiple concurrent users. The free tier is subject to Google's current eligibility, region, disk, and network rules. You may need billing enabled to create resources, and usage outside the free allowance can cost money. Set a budget alert before launching.

## 1. Create the VM

In Google Cloud Console:

1. Create/select a Google Cloud project and enable billing (Google may require a billing account even for free-tier resources).
2. Open **Compute Engine → VM instances → Create instance**.
3. Choose a free-tier-eligible US region/zone, machine type **e2-micro**, and Debian 12 or Ubuntu LTS.
4. Use a standard persistent boot disk of 30 GB or less.
5. Under firewall, allow HTTP traffic. Do not open ports 3000, 3003, or 3004 to the internet.
6. Create the VM and open its SSH terminal.

## 2. Install runtime dependencies

Run on the VM:

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates build-essential python3 caddy
# Install Node.js 24 (required by node:sqlite in the collab service)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
# Install Bun for the Next.js app and lockfile
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
```

Check `node --version` (v24.x) and `bun --version`.

## 3. Clone and configure

```bash
sudo git clone https://github.com/TejashRajuKV/workspace.git /opt/workspace
sudo mkdir -p /var/lib/workspace
sudo chown -R "$USER":"$USER" /opt/workspace /var/lib/workspace
cd /opt/workspace
bun install --frozen-lockfile
(cd mini-services/collab-service && bun install --frozen-lockfile)
bun run db:generate
```

Create a random secret and environment file:

```bash
openssl rand -hex 32
sudo nano /etc/workspace.env
```

Put the following in `/etc/workspace.env`, replacing the secret with the generated value:

```bash
NODE_ENV=production
DATABASE_URL=file:/var/lib/workspace/custom.db
DATABASE_PATH=/var/lib/workspace/custom.db
INTERNAL_TOKEN=REPLACE_WITH_RANDOM_64_HEX_CHARACTERS
COLLAB_SERVICE_URL=http://127.0.0.1:3004
INTERNAL_PORT=3004
INTERNAL_HOST=127.0.0.1
```

Secure the file:

```bash
sudo chmod 600 /etc/workspace.env
sudo chown root:root /etc/workspace.env
```

Initialize the schema and build:

```bash
set -a
source /etc/workspace.env
set +a
bun run db:push
bun run build
```

If the build runs out of memory on the free-tier VM, build on your own computer or CI using compatible Linux/Node/Bun versions and deploy the generated runtime artifacts instead. Do not upgrade VM resources without checking the cost first.

## 4. Install systemd services

Create `/etc/systemd/system/workspace-collab.service`:

```ini
[Unit]
Description=Workspace collaboration service
After=network.target

[Service]
Type=simple
User=YOUR_LINUX_USERNAME
WorkingDirectory=/opt/workspace
EnvironmentFile=/etc/workspace.env
Environment=PORT=3003
ExecStart=/usr/bin/node /opt/workspace/mini-services/collab-service/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/workspace-web.service`:

```ini
[Unit]
Description=Workspace Next.js web app
After=network.target workspace-collab.service

[Service]
Type=simple
User=YOUR_LINUX_USERNAME
WorkingDirectory=/opt/workspace
EnvironmentFile=/etc/workspace.env
Environment=PORT=3000
ExecStart=/home/YOUR_LINUX_USERNAME/.bun/bin/bun run start:web
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Replace `YOUR_LINUX_USERNAME` with the Linux username you used over SSH. Confirm Bun's path with `which bun`; if it differs from `/home/YOUR_LINUX_USERNAME/.bun/bin/bun`, update `ExecStart`. The SQLite file must remain writable by this user.

Enable services:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now workspace-collab workspace-web
sudo systemctl status workspace-collab workspace-web --no-pager
```

## 5. Configure Caddy and HTTPS

If you have a domain, point its DNS A record to the VM's external IP, then use that domain as the Caddy site address. For testing without a domain, Caddy can serve HTTP on port 80, but browsers will not get trusted HTTPS.

Create `/etc/caddy/Caddyfile` (replace `workspace.example.com` with your domain):

```caddy
workspace.example.com {
    @collab query XTransformPort=3003
    handle @collab {
        reverse_proxy 127.0.0.1:3003
    }
    handle {
        reverse_proxy 127.0.0.1:3000
    }
}
```

Then run:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy will provision HTTPS automatically when the domain's DNS points to the VM and ports 80/443 are reachable. In the Google Cloud VPC firewall, allow HTTP and HTTPS. Keep ports 3000, 3003, and 3004 closed publicly; only Caddy should be public.

## 6. Smoke-test the deployed app

- Open the domain over HTTPS and register a test account.
- Create a workspace and verify the data survives a refresh.
- Open a second browser profile and verify real-time canvas/editor synchronization.
- Test the code runner cautiously with a harmless JavaScript example.
- Check logs with `sudo journalctl -u workspace-web -u workspace-collab -f`.
- Check that the SQLite database lives at `/var/lib/workspace/custom.db` and is backed up.

## Cost and security

No guide can guarantee a $0 bill: verify the current Google Cloud free-tier terms for your billing account and region, set a budget alert, and check usage after deployment. Do not enable untrusted public code execution until the runner is isolated with OS/container limits. Back up the SQLite database before upgrades.
