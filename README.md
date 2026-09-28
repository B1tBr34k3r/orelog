# OreLog

OreLog is a personal SupportXMR earnings dashboard. It polls the read-only miner stats endpoint once per minute, keeps a timestamped earnings log, and closes local-day records at midnight in the selected IANA timezone.

## Run locally

Requires Node.js 22 or newer.

```sh
npm install
npm run dev
```

Open the Vite URL printed in the terminal. Without `DATABASE_URL`, the collector uses `data/records.json` for local development. Enter a standard Monero address and a timezone such as `America/New_York` or `Asia/Kolkata`. Logging begins with the first successful pool snapshot; the app cannot reconstruct earnings from before monitoring began.

## GitHub Pages + Replit

GitHub Pages publishes the static dashboard UI. The Replit Reserved VM runs the collector and API continuously; Pages alone cannot run the collector or persist its database.

1. Push this project to a GitHub repository whose default branch is `main`, then select **GitHub Actions** as the Pages source in repository settings.
2. On Replit, add a PostgreSQL database and set its connection string as `DATABASE_URL`. Also set strong `DASHBOARD_PASSWORD` and `DASHBOARD_ALLOWED_ORIGIN` secrets. The allowed origin should be exactly `https://<owner>.github.io` (no repository path or trailing slash).
3. Publish the Replit app as a **Reserved VM** using `npm run build` and `npm start`. Note its public API URL.
4. In GitHub repository **Settings → Secrets and variables → Actions → Variables**, add `VITE_API_BASE_URL` with the Replit API URL, such as `https://your-app.replit.app`.
5. Push to `main` or run the **Deploy Pages** workflow. The workflow builds and publishes the dashboard.

The workflow computes the correct project-page asset path automatically. PostgreSQL is required for durable collector storage; the local JSON fallback is for development only because deployment filesystems may not persist files.

## Accounting notes

- Credited earnings are derived from changes in `amtPaid + amtDue`; a payout moving XMR from pending to paid does not count as a loss.
- Pool values are reported asynchronously. The dashboard is current to the latest pool snapshot, not a per-share ledger. When a polling interval crosses midnight, that interval is proportionally split between the two days.
- A gap longer than three polling intervals is flagged in the daily log and proportionally allocated. The affected period is an estimate, not a verified per-minute total.
- Daily records stay open throughout the day and are finalized at the first poll after local midnight. Miner inactivity does not stop collection.
- Snapshots are retained for 45 days; the dashboard shows the latest 31 daily records.

The collector only calls `GET /api/miner/{address}/stats`. It does not call payout, threshold, notification, or Tari-address mutation endpoints.