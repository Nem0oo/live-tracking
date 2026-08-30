# Live Tracking

A web app to follow multiple runners' GPS positions live on a map during a race, based on Garmin LiveTrack sessions.

Live at: **https://tracking.gcourtot.fr**

## Why

When several friends run the same race, I wanted to follow all of them live on a single map instead of juggling multiple Garmin LiveTrack links on my phone. Garmin's own page only shows one runner at a time and doesn't keep history well, so I built a lightweight map that polls each runner's LiveTrack session and plots their position, pace and heart rate side by side.

## What it does

- Displays every tracked runner's live position on a dark map (Leaflet + Esri tiles)
- Polls Garmin LiveTrack sessions on a configurable interval and draws each runner's path
- Shows live stats per runner: distance, recent pace, average heart rate
- Runners are fixed by the server (via an n8n webhook) and synced automatically — no manual setup needed on the page

## Usage

1. Open the page — runners are picked up automatically from the server every 60 seconds
2. Click a runner in the sidebar to zoom in on their route
3. Adjust the poll interval from the "Intervalle de poll" button if needed

## Stack

| Component   | Technology |
|-------------|------------|
| Frontend    | HTML / CSS / Vanilla JavaScript, Leaflet |
| Server      | Apache HTTPd (Docker image `httpd:alpine3.21`) |
| Backend     | n8n webhooks (`livetrack-runners`, `livetrack-proxy`) |
| CI/CD       | GitHub Actions |
| Registry    | Docker Hub |
| Deployment  | n8n (webhook → Watchtower) |

## Run locally

```bash
docker build -t tracking .
docker run -d -p 8080:80 tracking
# Open http://localhost:8080
```

## CI/CD

### Pull Request → `main`

1. Build the Docker image
2. Start the container
3. Verify that `/version.txt` contains the correct commit SHA

### Push to `main`

1. Tag the current `latest` image as `previous` (for rollback)
2. Build and push the new `latest` image to Docker Hub
3. Trigger deployment via n8n webhook
4. Verify in production that `/version.txt` matches the expected SHA
5. **Automatic rollback** if the production check fails: `previous` is re-tagged as `latest` and redeployed

### Required secrets

| Secret | Description |
|--------|-------------|
| `DOCKERHUB_USERNAME` | Docker Hub username |
| `DOCKERHUB_TOKEN`    | Docker Hub access token |
| `N8N_WEBHOOK_ID`     | n8n webhook ID triggering the redeployment |

---

MIT License — Nem0oo
