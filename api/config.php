<?php
// ============================================================
// OreLog — InfinityFree Configuration
//
// Get these values from your InfinityFree control panel:
//   Control Panel → MySQL Databases → Create a database
//
// After creating the database, fill in the four values below.
// ============================================================

define('DB_HOST', 'sql123.infinityfree.com');   // ← MySQL host from control panel
define('DB_NAME', 'if0_12345678_orelog');        // ← Database name
define('DB_USER', 'if0_12345678');               // ← Username
define('DB_PASS', 'your_password_here');         // ← Password

// How many seconds between polls to SupportXMR (keep under 60)
define('POLL_COOLDOWN', 55);
