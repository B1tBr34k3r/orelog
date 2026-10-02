# OreLog — InfinityFree Deployment Guide

## What You'll Upload

```
htdocs/                          ← InfinityFree web root
├── .htaccess                    ← from dist/.htaccess
├── index.html                   ← from dist/index.html
├── favicon.svg                  ← from dist/favicon.svg
├── icons.svg                    ← from dist/icons.svg
├── assets/                      ← from dist/assets/
│   ├── index-XXXXX.css
│   ├── index-XXXXX.js
│   ├── EarningsChart-XXXXX.js
│   ├── DailyBarChart-XXXXX.js
│   └── CartesianChart-XXXXX.js
└── api/                         ← from api/
    ├── config.php               ← ⚠️ EDIT THIS FIRST
    ├── db.php
    ├── helpers.php
    ├── data.php
    ├── settings.php
    ├── poll.php
    └── export.php
```

## Step-by-Step

### 1. Create a free account on InfinityFree
Go to https://infinityfree.com and sign up.

### 2. Create a MySQL database
- Control Panel → **MySQL Databases**
- Create a new database
- Note down: **Host**, **Database name**, **Username**, **Password**

### 3. Edit `api/config.php`
Open `api/config.php` and fill in your MySQL credentials:

```php
define('DB_HOST', 'sql123.infinityfree.com');   // ← your MySQL host
define('DB_NAME', 'if0_12345678_orelog');        // ← your database name
define('DB_USER', 'if0_12345678');               // ← your username
define('DB_PASS', 'your_password_here');         // ← your password
```

### 4. Upload files via File Manager or FTP
Upload to `htdocs/`:
- Everything from `dist/` → `htdocs/` (index.html, .htaccess, assets/, favicon.svg, icons.svg)
- The entire `api/` folder → `htdocs/api/`

> **FTP credentials** are in your InfinityFree control panel under "FTP Accounts".

### 5. Visit your site
Open `https://your-subdomain.infinityfree.com`
- You should see the OreLog setup screen
- Enter your Monero wallet address
- Data collection begins immediately

## Rebuilding After Code Changes

If you modify the React source (`src/`):

```powershell
npm run build
```

Then re-upload `dist/*` to `htdocs/` (the `api/` folder doesn't need re-uploading unless you changed it).

## Troubleshooting

| Problem | Fix |
|---|---|
| Blank page | Make sure `.htaccess` was uploaded (it's a hidden file) |
| "Unable to load dashboard data" | Check `api/config.php` has correct MySQL credentials |
| Tables not created | Visit `https://your-site.com/api/poll` once to trigger schema init |
| 500 error on API | Check InfinityFree's error logs in the control panel |
| Data not updating | Keep the page open — polling only happens when someone visits |
