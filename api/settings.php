<?php
// ============================================================
// PUT/POST  /api/settings  → Save wallet address + timezone
// ============================================================
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';

header('Content-Type: application/json');
$db = getDB();

$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'OPTIONS') { http_response_code(204); exit; }
if ($method !== 'PUT' && $method !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

$input   = json_decode(file_get_contents('php://input'), true) ?: [];
$address = trim($input['address'] ?? '');
$tz      = trim($input['timeZone'] ?? 'UTC');

// ── Validate address ──
if (!preg_match('/^[48][A-Za-z0-9]{94,105}$/', $address)) {
    http_response_code(400);
    echo json_encode(['error' => 'Enter a valid standard Monero address']);
    exit;
}

// ── Validate timezone ──
try {
    new DateTimeZone($tz);
} catch (Exception $e) {
    http_response_code(400);
    echo json_encode(['error' => 'Enter a valid IANA time zone, such as Europe/London']);
    exit;
}

// ── Check if settings changed (triggers a reset) ──
$previous = $db->query("SELECT address, time_zone FROM settings WHERE id = 1")->fetch();
$reset = $previous && ($previous['address'] !== $address || $previous['time_zone'] !== $tz);

// ── Save settings ──
$stmt = $db->prepare(
    "INSERT INTO settings (id, address, time_zone) VALUES (1, ?, ?)
     ON DUPLICATE KEY UPDATE address = VALUES(address), time_zone = VALUES(time_zone)"
);
$stmt->execute([$address, $tz]);

// ── If address/timezone changed, clear all history ──
if ($reset) {
    $db->exec("DELETE FROM snapshots");
    $db->exec("ALTER TABLE snapshots AUTO_INCREMENT = 1");
    $db->exec("DELETE FROM worker_snapshots");
    $db->exec("DELETE FROM daily_records");
    $db->prepare("UPDATE poll_state SET last_poll_at = NULL, last_error = NULL WHERE id = 1")->execute();
    // Remove schema flag so tables are verified fresh
    @unlink(__DIR__ . '/.schema_ok');
}

// ── Clear any previous error ──
$db->prepare("UPDATE poll_state SET last_error = NULL WHERE id = 1")->execute();

// ── Trigger an immediate first poll ──
doPoll($db);

echo json_encode(['ok' => true, 'reset' => $reset]);
