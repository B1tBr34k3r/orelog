# OreLog

OreLog is a local SupportXMR earnings monitor. It polls the read-only miner stats API once per minute, records cumulative paid-plus-pending XMR, and closes daily records at midnight in your selected timezone.

## Install on Android with Termux

Install Termux from F-Droid or the official GitHub releases, then install the matching Termux:API add-on if you want to use its wake-lock command. Avoid the outdated Play Store build.

The repository is private, so first sign in to GitHub in your Android browser and download the repository ZIP from the OreLog page. Then in Termux:

```sh
termux-setup-storage
pkg update && pkg upgrade
pkg install nodejs-lts unzip
cd ~
unzip ~/storage/downloads/orelog-main.zip
cd orelog-main
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:3000` in the browser on that phone. Enter your Monero address and timezone once. The app writes its database to `data/records.json` in the project directory.

## Keep it running

Android may suspend or kill background apps, so phone-based collection is not guaranteed 24/7. In Android app settings, allow Termux unrestricted battery use, disable battery saver while collecting, keep the phone powered, and keep the Termux session running. With Termux:API installed, run `termux-wake-lock` in a second session to reduce sleep interruptions; use `termux-wake-unlock` when finished. A reboot, force-stop, network loss, or Android process kill creates a collection gap.

The server binds to `127.0.0.1` by default, so the dashboard is only reachable from the phone itself. Do not change `HOST` to `0.0.0.0` unless you intend to expose it to your local network and have set `DASHBOARD_PASSWORD`.

## Move existing history from the PC

The local history file is deliberately excluded from Git because it contains your wallet address and earnings. If you want to continue that history on the phone, securely copy the PC's `data/records.json` into `~/orelog-main/data/records.json` before starting OreLog. Do not upload this file to GitHub or share it publicly. If you do not copy it, monitoring starts with the first successful phone-side snapshot and cannot reconstruct earlier earnings.

Historical hashrate points are not currently imported into OreLog. Earnings are calculated from pool-reported `amtPaid + amtDue`, not estimated from hashrate. Payouts therefore move value from pending to paid without appearing as an earnings loss.

## Development on Termux

To use the Vite development server instead of the built app, run `npm run dev` and open the printed local URL. Use `Ctrl+C` to stop it.

## Data and accuracy

- Snapshots are collected every 60 seconds and retained for 45 days; the dashboard shows the latest 31 daily records.
- The first snapshot establishes a baseline and is not counted as newly earned XMR.
- When a sample interval crosses local midnight, its earnings are proportionally split across the two days.
- Gaps longer than three polls are flagged. Any earnings spanning a gap are allocated proportionally and are estimates, not verified per-minute totals.
- The daily log stays open while the miner is idle and is finalized on the first successful poll after local midnight.
- OreLog only calls `GET /api/miner/{address}/stats`; it does not trigger payouts or change pool settings.