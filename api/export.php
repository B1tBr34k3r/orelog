<?php
// ============================================================
// GET  /api/export  → Download a JSON backup of collected data
//
// Query params:
//   scope = all | today | date
//   date  = YYYY-MM-DD (when scope=date)
// ============================================================
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';

$db = getDB();

$scope = $_GET['scope'] ?? 'all';
$date  = isset($_GET['date']) ? $_GET['date'] : null;

$settings = $db->query("SELECT address, time_zone FROM settings WHERE id = 1")->fetch();
$tz = $settings['time_zone'] ?? 'UTC';

$isAll  = false;
$dayKey = null;
$fromDt = null;
$toDt   = null;

if ($scope === 'all') {
    $isAll = true;
} elseif ($scope === 'today') {
    $dayKey = timeZoneDayKey(time(), $tz);
    $from   = dayStartTimestamp($dayKey, $tz);
    $to     = dayStartTimestamp(nextDayKey($dayKey), $tz) - 1;
    $fromDt = gmdate('Y-m-d H:i:s', $from);
    $toDt   = gmdate('Y-m-d H:i:s', $to);
} elseif ($scope === 'date' && $date) {
    $dayKey = $date;
    $from   = dayStartTimestamp($dayKey, $tz);
    $to     = dayStartTimestamp(nextDayKey($dayKey), $tz) - 1;
    $fromDt = gmdate('Y-m-d H:i:s', $from);
    $toDt   = gmdate('Y-m-d H:i:s', $to);
} else {
    header('Content-Type: application/json');
    http_response_code(400);
    echo json_encode(['error' => 'Invalid scope or date']);
    exit;
}

// ── Query data ──
if ($isAll) {
    $snapRows   = $db->query("SELECT * FROM snapshots ORDER BY recorded_at")->fetchAll();
    $workerRows = $db->query("SELECT * FROM worker_snapshots ORDER BY recorded_at")->fetchAll();
    $dayRows    = $db->query("SELECT * FROM daily_records ORDER BY day_key")->fetchAll();
} else {
    $s = $db->prepare("SELECT * FROM snapshots WHERE recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at");
    $s->execute([$fromDt, $toDt]);
    $snapRows = $s->fetchAll();

    $w = $db->prepare("SELECT * FROM worker_snapshots WHERE recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at");
    $w->execute([$fromDt, $toDt]);
    $workerRows = $w->fetchAll();

    $d = $db->prepare("SELECT * FROM daily_records WHERE day_key = ?");
    $d->execute([$dayKey]);
    $dayRows = $d->fetchAll();
}

// ── Build export object ──
$export = [
    'exportedAt'      => gmdate('c'),
    'scope'           => $scope,
    'date'            => $date,
    'settings'        => $settings ? ['address' => $settings['address'], 'timeZone' => $settings['time_zone']] : null,
    'snapshots'       => array_map('formatSnapshot', $snapRows),
    'workerSnapshots' => groupWorkerSnapshots($workerRows),
    'days'            => array_map('formatDay', $dayRows),
];

// ── Send as downloadable JSON file ──
$filename = 'orelog-' . $scope . ($date ? "-$date" : '') . '-' . time() . '.json';
header('Content-Type: application/json');
header('Content-Disposition: attachment; filename="' . $filename . '"');
echo json_encode($export, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
