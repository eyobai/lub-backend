# Deploying the backend on a DigitalOcean Droplet

One Droplet runs everything: the API, PostgreSQL, Redis, and Caddy, which serves the API over HTTPS with a
certificate it renews by itself. Only ports 22 (SSH), 80 and 443 are open; the database and Redis are not
reachable from the internet.

This guide uses `api.leyubid.com` for the API, `leyubid.com` for the user site and `admin.leyubid.com` for the
admin site.

## 1. Create the Droplet

1. DigitalOcean → Create → Droplets.
2. Image **Ubuntu 24.04 LTS**. Size: **Basic, 2 GB RAM / 1 CPU** at least (4 GB is more comfortable).
3. Region: the closest to Ethiopia, usually **Frankfurt (FRA1)**.
4. Authentication: **SSH key** (add your computer's public key), not a password.
5. Create it and note its **IPv4 address**.

## 2. Point the API's name at it

Where your domain's DNS is managed (in cPanel: _Domains → Zone Editor_), add:

| Type | Name  | Value              |
| ---- | ----- | ------------------ |
| A    | `api` | the Droplet's IPv4 |

Wait until `ping api.leyubid.com` answers with that address (usually a few minutes).

## 3. Prepare the server

Connect from your computer (PowerShell works): `ssh root@<droplet-ip>`, then:

```bash
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

## 4. Get the code and fill in the settings

```bash
git clone https://github.com/eyobai/lub-backend.git
cd lub-backend
cp deploy/.env.production.example deploy/.env.production
nano deploy/.env.production
```

Fill in every empty value. Make the secrets with `openssl rand -hex 24` (database password) and
`openssl rand -base64 48` (each of the three JWT/OTP secrets, all different). Save with Ctrl+O, Enter, Ctrl+X.
`deploy/.env.production` never goes into git.

## 5. Start it

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production up -d --build
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production run --rm api npx prisma migrate deploy
```

The second line creates the database tables. Then make the first super admin (use a phone number you own):

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production run --rm \
  -e SEED_ADMIN_PHONE=+2519XXXXXXXX -e SEED_ADMIN_PASSWORD='a-strong-password' api node dist/scripts/seed-admin.js
```

Check it: open `https://api.leyubid.com/health/ready` in a browser. It should answer with `"status":"ok"` and the database and Redis `"up"`.
If the page does not load, see the logs:

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production logs -f --tail=100
```

## 6. Chapa

In Chapa's dashboard set the webhook URL to `https://api.leyubid.com/api/v1/payments/chapa/webhook`, and the
secret hash to the value of `CHAPA_WEBHOOK_SECRET`. Test with a `CHASECK_TEST-…` key first; switch to the live key
only after a test payment worked end to end. Do not switch keys while payments are waiting.

## 7. Product pictures (Cloudflare R2)

Pictures uploaded in the admin site are stored in a Cloudflare R2 bucket and served from it. Until this is set up,
the admin site only offers to add pictures by address.

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) and open **R2 Object Storage**. Activate it (a card is
   asked for; the free allowance covers about 10 GB).
2. **Create bucket**: name `leyubid-images`, location _Automatic_.
3. Give it a public address. Best: move the DNS of `leyubid.com` to Cloudflare, then in the bucket open
   **Settings → Custom Domains → Connect Domain** and enter `images.leyubid.com`. Quicker, for testing only:
   **Settings → Public Development URL → Enable**, which gives a `https://pub-….r2.dev` address (rate-limited).
4. **R2 → Manage API tokens → Create API token**: permission _Object Read & Write_, applied to the
   `leyubid-images` bucket only. Copy the **Access Key ID** and **Secret Access Key** (shown once) and note the
   **Account ID** shown on the R2 page.
5. On the server, fill these in `deploy/.env.production`:

   ```
   R2_ACCOUNT_ID=<account id>
   UPLOADS_BUCKET=leyubid-images
   UPLOADS_ACCESS_KEY_ID=<access key id>
   UPLOADS_SECRET_ACCESS_KEY=<secret access key>
   UPLOADS_PUBLIC_URL=https://images.leyubid.com
   ```

   then apply them: `docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production up -d api`.

The admin site's product page then shows **Upload pictures**. JPEG, PNG and WebP up to 5 MB are accepted
(`UPLOADS_MAX_MB`). Files go straight from the API to R2; nothing is kept on the Droplet.

## Updating to a new version

```bash
cd lub-backend
git pull
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production up -d --build
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production run --rm api npx prisma migrate deploy
```

## Backups

The database holds every user's money: back it up. Turn on **Droplet backups** in DigitalOcean (weekly), and
keep a daily copy of the database itself, for example with this line in `crontab -e`:

```
0 3 * * * cd /root/lub-backend && docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production exec -T postgres pg_dump -U leyubid leyubid | gzip > /root/backups/leyubid-$(date +\%F).sql.gz
```

(create the folder first with `mkdir -p /root/backups`, and copy the files off the server now and then).
