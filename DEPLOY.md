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
