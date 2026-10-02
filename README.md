<div align="center">

# ⚡ ORELOG

### **High-Precision, Privacy-First Monero (XMR) Mining Monitor & Earnings Dashboard**

[![Node.js](https://img.shields.io/badge/Node.js-v20+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev)
[![Monero](https://img.shields.io/badge/Monero-XMR-FF6600?style=for-the-badge&logo=monero&logoColor=white)](https://getmonero.org)
[![License](https://img.shields.io/badge/License-MIT-acid?style=for-the-badge)](LICENSE)

<p align="center">
  <b>Self-hosted, verified earnings analytics, live active miner telemetry, and zero-cost real-time fiat valuation (USD & INR).</b>
</p>

---

</div>

## 🌟 Highlights

- 🪙 **True Balance Tracking:** Tracks cumulative pool rewards (`amtPaid` + `amtDue`) so payout events never appear as earning drops.
- 💵 **Real-Time Dual Fiat Conversion:** Instant live pricing in **USD ($)** and **INR (₹)** with dual API redundancy (CoinGecko & CoinPaprika) and smart caching (zero API keys needed).
- ⛏️ **Active Miner Telemetry:** Real-time worker cards showing live status badges (`MINING` vs `IDLE`), current hashrates ($H/s$, $KH/s$, $MH/s$), and last share latency.
- 📈 **Interactive Interval Analysis:** View earnings over **1 Hour**, **24 Hours**, **Today** (since local midnight), or custom intervals with instant hourly rate projections.
- 🕒 **Timezone-Aware Daily Accounting:** Automatically finalizes daily earnings at local midnight based on verified active uptime.
- 🔒 **100% Read-Only & Private:** Only calls public pool stats endpoints. No private keys, no seed phrases, no transaction capabilities.
- 💾 **Data Ownership & Backup:** Single-click JSON exports by day or full history, with selective database pruning tools.
- 🚀 **Universal Deployment:** Runs effortlessly on **Cloud VPS** (Oracle Cloud, DigitalOcean, AWS), **Shared Hosting / PHP** (InfinityFree, cPanel), **Docker**, or **Android / Termux**.

---

## 📸 Dashboard Overview

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  ⚡ ORELOG   /  SUPPORTXMR · MONERO   [1 XMR ≈ $549.60 · ₹52,810]  [COLLECTING ●] │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  CREDITS IN INTERVAL (LAST 24 HOURS)                TODAY · MIDNIGHT RESET       │
│  0.01428500 XMR                                     0.00892000 XMR               │
│  ≈ $7.85 · ₹754.40                                  ≈ $4.90 · ₹471.10            │
│  ↗ 0.00059520 XMR/HR  (≈ $0.33/hr · ₹31.43/hr)                                  │
│                                                     PENDING POOL BALANCE         │
│  [1H] [24H] [TODAY] [CUSTOM]                        0.02923137 XMR               │
│                                                     ≈ $16.06 · ₹1,543.80         │
├──────────────────────────────────────────────────────────────────────────────────┤
│  ACTIVE MINERS · 2 MINING NOW                                                    │
│  ┌───────────────────────────────┐   ┌───────────────────────────────┐           │
│  │ 💻 rig-epyc        [MINING ●] │   │ 💻 desktop-ryzen   [MINING ●] │           │
│  │ 14.85 KH/s · Last share 12s   │   │ 4.20 KH/s · Last share 38s    │           │
│  └───────────────────────────────┘   └───────────────────────────────┘           │
├──────────────────────────────────────────────────────────────────────────────────┤
│  CUMULATIVE POOL CREDIT (CHART)                     DAILY EARNINGS LEDGER        │
│  [──────────────────────────────]                   2026-10-02   0.008920 XMR    │
│                                                     2026-10-01   0.015400 XMR    │
│                                                     2026-09-30   0.014890 XMR    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quickstart & Deployment

### Option 1: Linux / Cloud VPS (Recommended)
*Ideal for Oracle Cloud Free Tier, DigitalOcean, AWS EC2, or a home server.*

```bash
# 1. Clone the repository
git clone https://github.com/B1tBr34k3r/orelog.git
cd orelog

# 2. Install dependencies & build UI
npm install
npm run build

# 3. Start with PM2 (runs 24/7 in background)
npm install -g pm2
pm2 start server/index.mjs --name "orelog"
pm2 save
pm2 startup
```

Open `http://<your-server-ip>:3000` in your browser. Enter your Monero wallet address and timezone on first setup.

---

### Option 2: Shared Hosting / PHP (InfinityFree, Apache, cPanel)
*Zero server management required.*

1. Run `npm run build` locally.
2. Upload the contents of `dist/` and `api/` to your host's web root (`htdocs/` or `public_html/`).
3. Set your MySQL credentials in `api/config.php`.
4. Open your domain in any browser to begin monitoring.

---

### Option 3: Local Development

```bash
# Start backend and Vite dev server with hot reload
npm run dev
```

Visit `http://localhost:5173` (Vite) or `http://localhost:3000` (API Server).

---

### Option 4: Android (via Termux)

```bash
termux-setup-storage
pkg update && pkg install nodejs-lts git
git clone https://github.com/B1tBr34k3r/orelog.git
cd orelog
npm install
npm run build
npm start
```
Open `http://127.0.0.1:3000` in your mobile browser.

---

## ⚙️ How OreLog Calculates Earnings

Monero pools utilize **PPLNS (Pay Per Last N Shares)**. When blocks are found, rewards are credited to your account balance (`amtDue`). When payout thresholds are reached, funds transfer to `amtPaid`.

OreLog computes true earnings by tracking cumulative pool balance snapshots:

```text
Cumulative XMR = amtPaid + amtDue
Earned Delta   = Cumulative(current) - Cumulative(previous)
```

- **Payout-Proof:** When a payout occurs, `amtDue` decreases while `amtPaid` increases by the exact same amount—keeping your cumulative earnings continuous with zero false dips.
- **Active Monitoring:** Earnings are only recorded from verified pool balance changes during active server uptime.
- **Real-Time Fiat:** Live fiat conversions evaluate `Earned XMR × Spot Price`, updated every 5 minutes from CoinGecko / CoinPaprika.

---

## 🛠️ Tech Stack

- **Frontend:** React 19, TypeScript, Vite, Recharts, Lucide Icons, Vanilla CSS Grid/Flexbox
- **Backend (Node):** Express, Pure-JS JSONL streaming store / PostgreSQL engine
- **Backend (PHP):** PHP 8.x + PDO SQLite/MySQL fallback engine
- **Price Feeds:** CoinGecko API & CoinPaprika REST API (dual-fallback with TTL cache)

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).