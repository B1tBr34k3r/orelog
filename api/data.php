<?php
// ============================================================
// GET  /api/data  → Returns dashboard data (with auto-poll)
// DELETE /api/data → Deletes collected data by scope
// ============================================================
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';

header('Content-Type: application/json');
$db = getDB();
$method = $_SERVER['REQUEST_METHOD'];

// ── Handle OPTIONS preflight ──
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ── DELETE: remove collected data ──
if ($method === 'DELETE' || ($method === 'POST' && ($_GET['_method'] ?? '') === 'DELETE')) {
    $input = json_decode(file_get_contents('php://input'), true) ?: [];
    $scope = $input['scope'] ?? '';
    $date  = $input['date'] ?? null;

    $settings = $db->query("SELECT time_zone FROM settings WHERE id = 1")->fetch();
    $tz = $settings['time_zone'] ?? 'UTC';

    if ($scope === 'all') {
        $db->exec("DELETE FROM snapshots");
        $db->exec("DELETE FROM worker_snapshots");
        $db->exec("DELETE FROM daily_records");
        // Reset auto-increment
        $db->exec("ALTER TABLE snapshots AUTO_INCREMENT = 1");
    } elseif ($scope === 'today') {
        $dayKey = timeZoneDayKey(time(), $tz);
        $from   = dayStartTimestamp($dayKey, $tz);
        $to     = dayStartTimestamp(nextDayKey($dayKey), $tz) - 1;
        deleteRange($db, $from, $to, $dayKey);
    } elseif ($scope === 'date' && $date) {
        $from = dayStartTimestamp($date, $tz);
        $to   = dayStartTimestamp(nextDayKey($date), $tz) - 1;
        deleteRange($db, $from, $to, $date);
    } else {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid scope or date']);
        exit;
    }

    echo json_encode(['ok' => true, 'scope' => $scope, 'date' => $date]);
    exit;
}

// ── GET: return dashboard data ──

// Auto-trigger a poll if cooldown has passed
$settings = $db->query("SELECT address, time_zone FROM settings WHERE id = 1")->fetch();
if ($settings && !empty($settings['address'])) {
    try {
        $ps = $db->query("SELECT last_poll_at FROM poll_state WHERE id = 1")->fetch();
        $elapsed = ($ps && $ps['last_poll_at']) ? time() - strtotime($ps['last_poll_at']) : 9999;
        if ($elapsed >= POLL_COOLDOWN) {
            doPoll($db);
        }
    } catch (Exception $e) {
        // Silently continue — stale data is better than no data
    }
}

$nowMs = time() * 1000;
$from  = isset($_GET['from']) ? (int)$_GET['from'] : $nowMs - 86400000;
$to    = min($nowMs, isset($_GET['to']) ? (int)$_GET['to'] : $nowMs);

if ($to < $from) {
    http_response_code(400);
    echo json_encode(['error' => 'End time must be after start time']);
    exit;
}

$fromDt = gmdate('Y-m-d H:i:s', intdiv($from, 1000));
$toDt   = gmdate('Y-m-d H:i:s', intdiv($to, 1000));

// Settings (formatted for frontend)
$settingsOut = $settings
    ? ['address' => $settings['address'], 'timeZone' => $settings['time_zone']]
    : null;

// Latest snapshot
$latest = $db->query("SELECT * FROM snapshots ORDER BY recorded_at DESC LIMIT 1")->fetch();

// Snapshots in range with one boundary sample before + after
$snapStmt = $db->prepare("
    (SELECT * FROM snapshots WHERE recorded_at < ? ORDER BY recorded_at DESC LIMIT 1)
    UNION ALL
    (SELECT * FROM snapshots WHERE recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at)
    UNION ALL
    (SELECT * FROM snapshots WHERE recorded_at > ? ORDER BY recorded_at ASC LIMIT 1)
");
$snapStmt->execute([$fromDt, $fromDt, $toDt, $toDt]);
$snapRows = $snapStmt->fetchAll();

// Worker snapshots in range with boundary snapshots
$wBefore = $db->prepare(
    "SELECT * FROM worker_snapshots WHERE recorded_at = (
        SELECT MAX(recorded_at) FROM worker_snapshots WHERE recorded_at < ?
    )"
);
$wBefore->execute([$fromDt]);
$wWithin = $db->prepare(
    "SELECT * FROM worker_snapshots WHERE recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at"
);
$wWithin->execute([$fromDt, $toDt]);
$wAfter = $db->prepare(
    "SELECT * FROM worker_snapshots WHERE recorded_at = (
        SELECT MIN(recorded_at) FROM worker_snapshots WHERE recorded_at > ?
    )"
);
$wAfter->execute([$toDt]);
$wRows = array_merge($wBefore->fetchAll(), $wWithin->fetchAll(), $wAfter->fetchAll());

// Daily records (last 365 days / 12 months)
$days = $db->query("SELECT * FROM daily_records ORDER BY day_key DESC LIMIT 365")->fetchAll();

// Poll state
$pollState = $db->query("SELECT * FROM poll_state WHERE id = 1")->fetch();

// Format snapshots
$snapshots = array_map('formatSnapshot', $snapRows);
$workerSnapshots = groupWorkerSnapshots($wRows);
$activeWorkers = [];
if (!empty($pollState['active_workers'])) {
    $activeWorkers = json_decode($pollState['active_workers'], true) ?: [];
}

// Downsample long ranges
$durationMs = $to - $from;
if ($durationMs > 86400000) {
    $bucketMs = $durationMs > 7 * 86400000 ? 86400000 : 3600000;
    $snapshots       = downsampleSnapshots($snapshots, $bucketMs);
    $workerSnapshots = downsampleWorkers($workerSnapshots, $bucketMs);
}

// Fiat conversion rates
$fiat = getFiatRates($db);

echo json_encode([
    'settings'        => $settingsOut,
    'latest'          => formatSnapshot($latest),
    'snapshots'       => $snapshots,
    'workers'         => $activeWorkers,
    'workerSnapshots' => $workerSnapshots,
    'days'            => array_map('formatDay', $days),
    'fiat'            => $fiat,
    'collector'       => [
        'lastPollAt' => $pollState['last_poll_at'] ?? null,
        'lastError'  => $pollState['last_error'] ?? null,
        'isPolling'  => false,
    ],
    'serverTime'      => gmdate('c'),
]);

// ── Helper ──
function deleteRange(PDO $db, int $from, int $to, string $dayKey): void {
    $fromDt = gmdate('Y-m-d H:i:s', $from);
    $toDt   = gmdate('Y-m-d H:i:s', $to);
    $db->prepare("DELETE FROM snapshots WHERE recorded_at >= ? AND recorded_at <= ?")->execute([$fromDt, $toDt]);
    $db->prepare("DELETE FROM worker_snapshots WHERE recorded_at >= ? AND recorded_at <= ?")->execute([$fromDt, $toDt]);
    $db->prepare("DELETE FROM daily_records WHERE day_key = ?")->execute([$dayKey]);
}
