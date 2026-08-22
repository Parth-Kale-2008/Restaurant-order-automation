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

**Setting `MONGODB_URI` does NOT currently fix this — it makes it worse.** `lib/mongo.js` is a
one-way mirror: it has `connect`/`sync`/`close` but **no restore path**. At boot the server calls
`mongo.sync(store.getDb())` with whatever the local store holds, and `runSync()` ends with

```js
await database.collection("restaurants").deleteMany({ slug: { $nin: slugs } });
await database.collection("orders").deleteMany({ id: { $nin: ids } });
```

So on a fresh container the local store is empty, and that first sync **deletes every restaurant
and every order from MongoDB** — destroying the backup rather than restoring from it.

Before running on an ephemeral host, do one of:

1. **Add a restore path** — on boot, if the local store is empty and Mongo has data, load from
   Mongo instead of syncing over it. (Not yet implemented.)
2. **Attach a persistent disk** mounted at `data/` (Render paid tier), or
3. Accept that it is a **demo only** and that orders/QRs reset on each restart.

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
