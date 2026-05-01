# GitHub Actions Deploy — Setup Guide

This is the deployment path Braavolabs **must** use going forward. The
old "build on the Lightsail host" path repeatedly OOM-killed the kernel
because Next.js + multi-stage Docker builds peak well above the 1.9GB
RAM the nano instance has. GitHub Actions runners (4-core, 16GB RAM)
build the images, push to ghcr.io, then SSH to the Lightsail host and
run `docker compose pull && up -d`. The host's RAM usage during deploy
is ~50MB.

---

## 1. One-time setup — add GitHub repository secrets

Go to https://github.com/kocakkmustafa/braavolabs/settings/secrets/actions
and add:

| Secret name           | Value                                                    |
| --------------------- | -------------------------------------------------------- |
| `LIGHTSAIL_HOST`      | `63.180.74.27` (the Lightsail public IPv4)               |
| `LIGHTSAIL_USER`      | `ubuntu`                                                 |
| `LIGHTSAIL_SSH_KEY`   | Full contents of `~/.ssh/id_ed25519` on your laptop      |
| `SLACK_DEPLOY_WEBHOOK` | (optional) Slack incoming-webhook URL                   |

For `LIGHTSAIL_SSH_KEY`, paste the entire file including the
`-----BEGIN OPENSSH PRIVATE KEY-----` header and footer lines. On the
Lightsail host the matching public key (`~/.ssh/id_ed25519.pub`) must
be in `~ubuntu/.ssh/authorized_keys` — which it already is, since
you've been SSHing as `ubuntu` from your laptop.

**Quick command to view the private key for copy-paste:**

```bash
cat ~/.ssh/id_ed25519
```

> ⚠️ Never commit this private key to the repo — paste it only into the
> GitHub Secrets UI (encrypted at rest).

---

## 2. One-time setup — make ghcr packages public OR keep private

After the first push to `main`, two new packages will appear under
https://github.com/kocakkmustafa/braavolabs/pkgs/container/braavolabs/api
and `.../ui`.

By default they're **private** (only the repo's `GITHUB_TOKEN` can pull).
You have two choices:

### Option A — Make them public (recommended, easier)

1. Go to the package page (link above)
2. Settings → "Change visibility" → Public
3. Repeat for the `ui` package
4. The Lightsail host can now pull without login

### Option B — Keep them private

1. On the Lightsail host, run:
   ```bash
   echo "<personal-access-token-with-read:packages-scope>" \
     | sudo docker login ghcr.io -u kocakkmustafa --password-stdin
   ```
2. The token + login is persisted in `~/.docker/config.json` and survives reboots.
3. Uncomment the `docker login` step in `.github/workflows/deploy.yml`.

For now we're going with Option A — much less moving parts.

---

## 3. One-time setup — enable Lightsail swap (resilience)

Even with off-loaded builds, having 4GB of swap on disk gives the
kernel a safety net for memory spikes (e.g. concurrent deploys, log
rotation, postgres VACUUM):

```bash
ssh ubuntu@63.180.74.27

# Check current swap
swapon --show
free -h

# Create 4GB swap file (one-time)
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make it persistent across reboots
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Tune for server workload (default swappiness=60 is too eager)
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf
sudo sysctl --system

# Verify
free -h
swapon --show
```

This adds 4GB virtual memory at the cost of ~4GB SSD space. With the
$12 Lightsail nano you have ~30GB SSD — plenty.

---

## 4. Normal workflow

```bash
# Make changes locally
git add ...
git commit -m "..."
git push origin main
```

GitHub Actions automatically:
1. Builds api + ui images in parallel (~5 min cold, ~90 sec cached)
2. Pushes to `ghcr.io/kocakkmustafa/braavolabs/{api,ui}:latest` + `:sha-XXXXXXXX`
3. SSHes to Lightsail
4. Syncs `ENV/compose.prod.yaml` and `packages/db/prisma/migrations/` (only)
5. Runs `docker compose pull api ui && up -d api ui`
6. Runs `prisma migrate deploy` inside the api container
7. Verifies `/api/v1/health` returns ok (5 retries, 10s apart)
8. Verifies the 5 main public pages return 200
9. (Optional) Posts a summary to Slack

Total wall time on a cached build: ~3-4 minutes from `git push` to
"production verified."

---

## 5. Rollback

Every successful build leaves an immutable `sha-XXXXXXXX` tag. To roll
back:

```bash
ssh ubuntu@63.180.74.27
sudo nano /opt/braavolabs/app/.env
# Add or modify this line:
IMAGE_TAG=sha-1af9837a
sudo docker compose -f /opt/braavolabs/app/ENV/compose.prod.yaml pull api ui
sudo docker compose -f /opt/braavolabs/app/ENV/compose.prod.yaml up -d api ui
```

The `IMAGE_TAG` env var in `compose.prod.yaml` defaults to `latest`,
so omitting / unsetting it returns you to the latest auto-deployed
build.

---

## 6. Triggering a manual deploy

If you need to redeploy without making a commit:

1. Go to https://github.com/kocakkmustafa/braavolabs/actions
2. Click "Build & Deploy" workflow
3. Click "Run workflow" → choose `production` → Run

This rebuilds + redeploys from the current `main` HEAD.

---

## 7. Tagged releases (optional, recommended for stability)

For production milestones, tag the commit:

```bash
git tag v1.0.0
git push origin v1.0.0
```

This builds with image tag `v1.0.0` instead of the `sha-...` style,
which makes rollback in step 5 readable (`IMAGE_TAG=v0.9.0`).

---

## 8. Troubleshooting

### Deploy step fails at "Set up SSH key"
- Check `LIGHTSAIL_SSH_KEY` secret is the full key content including
  header/footer lines. Common mistake: only pasting the base64 body.

### Deploy step fails at "Pull new images"
- Check the package visibility in step 2 — packages may still be
  private. Either make them public or set up `docker login` on the
  host (Option B).

### Deploy succeeds but health check fails
- Wait another minute and re-run from Actions UI — Next.js standalone
  cold-start can take 30-45 seconds for the first request after a
  container swap.
- If still failing: SSH and check `sudo docker logs aicos-api --tail 100`.

### "Unauthorized" pushing to ghcr.io
- The repository's `GITHUB_TOKEN` has `packages:write` only when the
  package belongs to the same repo. First push creates the package; if
  it's been linked to a different repo, you'll see this error.

### Build runs forever / hangs
- Check `concurrency.cancel-in-progress` — by default this workflow
  doesn't cancel in-progress builds (set to `false`) to avoid mid-build
  cancellations. If a build is genuinely stuck, cancel it manually
  from the Actions UI.

---

## 9. Migration plan (one-time)

To migrate from the current "rsync source + build on host" pattern:

1. **First push to main** — workflow builds and pushes images for the
   first time. This is the slow build (~5 min).
2. **First successful deploy** — the workflow's deploy step pulls
   from ghcr.io for the first time. After this point the host's
   `compose.prod.yaml` is using the registry image.
3. **Optional cleanup** — once the workflow is reliable, you can
   delete the old build pattern from your shell history. The
   `build:` directives in `compose.prod.yaml` are kept commented as
   a fallback but aren't used.
