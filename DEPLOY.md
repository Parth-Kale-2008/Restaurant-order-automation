# Deploying Anand Palace

## ⚠️ Read this first — data loss on ephemeral hosts

The app keeps everything (restaurants, tables, **QR tokens**, orders) in `data/db.json`, and its
signing secrets in `data/secrets.json`. Render's free tier, like most container hosts, gives the
service an **ephemeral filesystem**: both files are wiped on every deploy and every restart.

Consequences on a restart:

| Lost | Effect |
| ---- | ------ |
| `data/db.json` | tables + their QR tokens regenerate → **every printed QR code stops working** |
| `data/secrets.json` | managers logged out, guests' order cookies invalidated |

**Set `MONGODB_URI` and the data survives.** MongoDB is now the source of truth: at boot the
server reads Mongo first, and if it holds data the local file is rebuilt from it. Only an empty
Mongo gets seeded from the local store, and the sync hook is attached only after that decision,
so a restore can never echo back up. The HTTP server does not accept traffic until this settles.

This was verified by reproducing the failure and then re-running it:

| | restaurants | orders | table QR tokens |
| --- | --- | --- | --- |
| before, after one simulated restart | 2 -> **1** | 18 -> **0** | regenerated (printed QRs dead) |
| after the fix | 2 -> **2** | 18 -> **18** | **all 12 identical** |

Without `MONGODB_URI` the app still runs perfectly well on the JSON store — but on a host with
an ephemeral disk every restart resets it to a freshly seeded Anand Palace, which means new
tables, new QR tokens, and no order history. Fine for a demo, not for a live restaurant.

## Required environment variables

| Variable | Why |
| -------- | --- |
| `PUBLIC_URL` | The service's own https URL. **Table QR codes encode this** — wrong value = dead QRs. |
| `JWT_SECRET`, `COOKIE_SECRET` | Fixed values so sessions survive restarts (random per boot otherwise). |
| `MANAGER_PASSWORD`, `ADMIN_PASSWORD` | Defaults are `anand123` / `superadmin` — change before going public. |
| `MONGODB_URI` | Optional, and see the warning above. |
| `PORT` | Set by the host automatically. |

## Render

Render builds from a **connected Git repository** (GitHub/GitLab/Bitbucket) or a container image
in a registry — it cannot deploy a local folder. `render.yaml` in this directory is a blueprint
that Render picks up once the repo is linked.

1. Put this folder in a Git repo and push it to GitHub/GitLab.
2. Render dashboard → **New → Blueprint** → select the repo.
3. Fill in the env vars marked `sync: false`, especially `PUBLIC_URL`.
4. Deploy, then open `/admin`, go to **Tables & QR**, and **reprint the QR codes** so they encode
   the new public URL.

Note: free Render services sleep after ~15 minutes idle, so the first guest to scan a QR waits
roughly 30–60s for a cold start. For a live restaurant that is worth the paid tier.

## Other hosts

The app is host-agnostic: it reads `PORT`, binds `0.0.0.0`, trusts the proxy for https, and takes
`PUBLIC_URL` for QR generation. Anything that runs a Node process works.

## Oracle Cloud "Always Free" (recommended)

Free permanently, always-on, and — unlike Render — the **disk persists**, so the data-loss
warning at the top of this file stops applying. `MONGODB_URI` becomes optional.

### Why not Vercel / Netlify / serverless

This app cannot run on a serverless host, for three independent reasons:

| Code | Serverless problem |
| ---- | ------------------ |
| `new Server(server)` (socket.io) | No persistent connections, so the live dashboard never updates |
| `fs.writeFileSync(DB_FILE, ...)` in `lib/store.js` | Filesystem is read-only except a per-invocation `/tmp` |
| `initPersistence().then(() => server.listen(...))` | No controllable boot phase |

It needs a long-running process. A VM is the right shape.

### One-time setup

1. **Create the VM.** cloud.oracle.com -> Compute -> Instances -> Create.
   - Image **Ubuntu 22.04 or 24.04**
   - Shape **VM.Standard.A1.Flex**, 2 OCPU / 12 GB (Always Free allows up to 4 / 24)
   - Save the SSH private key it offers — it is shown once
   - If you get **"Out of capacity"**, that is normal for A1 in busy regions. Either retry
     periodically or fall back to `VM.Standard.E2.1.Micro`, which is also Always Free and
     ample for this app.

2. **Open the ports in the VCN.** Instance -> Subnet -> Default Security List ->
   Add Ingress Rules: source `0.0.0.0/0`, TCP, destination ports **80** and **443**.
   *(The VM's own iptables also blocks these; `setup-oracle.sh` fixes that side.)*

3. **Point a domain at the public IP** (optional but strongly recommended — it is what
   gets you HTTPS). An `A` record to the instance's public IP. A free DuckDNS subdomain
   works fine. Do this *before* step 4 so certbot can validate.

4. **Run the installer** over SSH:

   ```bash
   ssh -i your-key.pem ubuntu@YOUR_PUBLIC_IP
   curl -fsSL https://raw.githubusercontent.com/Parth-Kale-2008/anand-palace/master/deploy/setup-oracle.sh -o setup.sh
   chmod +x setup.sh
   ./setup.sh yourdomain.com      # omit the domain for plain http on the IP
   ```

   It installs Node 22, nginx and certbot, clones the repo to `/opt/anand-palace`,
   generates secrets into `/etc/anand-palace.env`, registers a systemd service, and
   configures nginx **with the WebSocket upgrade headers socket.io requires**.

5. **Read your generated passwords**, then reprint the QR codes:

   ```bash
   sudo grep PASSWORD /etc/anand-palace.env
   ```

   Open `/admin` -> **Tables & QR** -> reprint. Printed QRs encode `PUBLIC_URL`, so any
   codes printed against the old Render URL are dead.

### Day-to-day

```bash
sudo systemctl status anand-palace     # is it up
sudo journalctl -u anand-palace -f     # live logs
sudo systemctl restart anand-palace    # restart
/opt/anand-palace/deploy/update.sh     # pull latest code + restart
```

### Back up the data

The disk persists, but a VM can still be lost. `data/db.json` holds every table's QR token:

```bash
sudo tar czf ~/anand-backup-$(date +%F).tgz -C /opt/anand-palace data /etc/anand-palace.env
```

Worth a weekly cron job, or set `MONGODB_URI` to a free MongoDB Atlas M0 cluster and let
the existing sync keep an off-box copy.

### Keeping it free

Oracle reclaims **idle** Always Free compute (sustained low CPU over a 7-day window). A live
restaurant's traffic is normally enough. If the box is dormant between seasons, upgrade the
account to Pay As You Go — Always Free resources stay free on PAYG and become exempt from
reclamation, and you are not charged as long as you stay within the free shapes.
