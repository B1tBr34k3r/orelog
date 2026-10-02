<?php
// ============================================================
// GET  /api/poll  → Explicitly trigger a SupportXMR poll
// Also handles GET /healthz when routed via .htaccess
// ============================================================
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';

header('Content-Type: application/json');

// ── Health check shortcut ──
if (isset($_GET['healthz'])) {
    echo json_encode(['ok' => true]);
    exit;
}

$db = getDB();

// ── Check cooldown — don't hammer the pool API ──
$ps = $db->query("SELECT last_poll_at FROM poll_state WHERE id = 1")->fetch();
if ($ps && $ps['last_poll_at']) {
    $elapsed = time() - strtotime($ps['last_poll_at']);
    if ($elapsed < POLL_COOLDOWN) {
        echo json_encode(['ok' => true, 'skipped' => true, 'wait' => POLL_COOLDOWN - $elapsed]);
        exit;
    }
}

// ── Run the poll ──
$result = doPoll($db);
echo json_encode($result);
