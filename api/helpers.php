<?php
// ============================================================
// OreLog — Shared helper functions (PHP port of server/index.mjs)
//
// Provides: big integer math, timezone day helpers,
//           daily allocation, SupportXMR polling, formatters.
// ============================================================

// ---------- Big-integer helpers (bcmath with fallback) ----------

if (!function_exists('bcadd')) {
    // Fallback for hosts without bcmath — safe for values under ~9.2e18
    function bcadd($a, $b, $s = 0) { return (string)((int)$a + (int)$b); }
    function bcsub($a, $b, $s = 0) { return (string)((int)$a - (int)$b); }
    function bcmul($a, $b, $s = 0) { return (string)((int)$a * (int)$b); }
    function bcdiv($a, $b, $s = 0) { return (string)intdiv((int)$a, (int)$b); }
    function bccomp($a, $b, $s = 0) { return (int)$a <=> (int)$b; }
}

// ---------- Timezone / day-key helpers ----------

/**
 * Get the YYYY-MM-DD day key for a UNIX timestamp in a given timezone.
 */
function timeZoneDayKey(int $timestamp, string $timeZone): string {
    $dt = new DateTime("@$timestamp");
    $dt->setTimezone(new DateTimeZone($timeZone));
    return $dt->format('Y-m-d');
}

/**
 * Get the next calendar day key.
 */
function nextDayKey(string $dayKey): string {
    $dt = new DateTime($dayKey);
    $dt->modify('+1 day');
    return $dt->format('Y-m-d');
}

/**
 * Get the UNIX timestamp for midnight of a day in a given timezone.
 */
function dayStartTimestamp(string $dayKey, string $timeZone): int {
    $dt = new DateTime($dayKey . ' 00:00:00', new DateTimeZone($timeZone));
    return $dt->getTimestamp();
}

// ---------- Atomic conversion ----------

/**
 * Normalize a pool API value to an atomic (piconero) string.
 */
function toAtomic($value): string {
    if (is_string($value) && preg_match('/^\d+$/', $value)) {
        return $value;
    }
    $amount = floatval($value);
    if (!is_finite($amount) || $amount < 0) {
        throw new Exception('Pool returned an invalid XMR balance');
    }
    return (string)round($amount);
}

// ---------- Daily earnings allocation ----------

/**
 * Insert or update a day record — mirrors Node.js addDaySample.
 */
function addDaySample(PDO $db, string $dayKey, string $amount, string $recordedAt, bool $gap): void {
    $gapVal = $gap ? 1 : 0;

    // Ensure the row exists
    $ins = $db->prepare(
        "INSERT IGNORE INTO daily_records (day_key, earned_atomic, sample_count, gap_count, first_at, last_at)
         VALUES (?, '0', 0, 0, ?, ?)"
    );
    $ins->execute([$dayKey, $recordedAt, $recordedAt]);

    // Read current earned value
    $sel = $db->prepare("SELECT earned_atomic FROM daily_records WHERE day_key = ?");
    $sel->execute([$dayKey]);
    $current = $sel->fetchColumn() ?: '0';

    // Update with new totals
    $newEarned = bcadd($current, $amount);
    $upd = $db->prepare(
        "UPDATE daily_records SET earned_atomic = ?, sample_count = sample_count + 1,
         gap_count = gap_count + ?, last_at = ? WHERE day_key = ?"
    );
    $upd->execute([$newEarned, $gapVal, $recordedAt, $dayKey]);
}

/**
 * Ensure a day row exists (for the first snapshot of a new day).
 */
function initializeDay(PDO $db, string $dayKey, string $recordedAt): void {
    $stmt = $db->prepare(
        "INSERT IGNORE INTO daily_records (day_key, earned_atomic, sample_count, gap_count, first_at, last_at)
         VALUES (?, '0', 0, 0, ?, ?)"
    );
    $stmt->execute([$dayKey, $recordedAt, $recordedAt]);
}

/**
 * Mark all days before dayKey as finalized.
 */
function finalizeBefore(PDO $db, string $dayKey): void {
    $stmt = $db->prepare("UPDATE daily_records SET finalized = 1 WHERE day_key < ? AND finalized = 0");
    $stmt->execute([$dayKey]);
}

/**
 * Record a cumulative-balance delta during active monitoring.
 */
function allocateDelta(PDO $db, array $previous, array $current, string $timeZone): void {
    $totalDelta = bcsub($current['cumulative_atomic'], $previous['cumulative_atomic']);
    if (bccomp($totalDelta, '0') <= 0) return;

    $startTs = strtotime($previous['recorded_at']);
    $endTs   = strtotime($current['recorded_at']);
    $duration = $endTs - $startTs;
    if ($duration <= 0) return;

    // If server was offline (> 3 minutes), do not retroactively attribute offline delta
    if ($duration > 180) {
        return;
    }

    $currentKey = timeZoneDayKey($endTs, $timeZone);
    addDaySample($db, $currentKey, $totalDelta, $current['recorded_at'], false);
}

// ---------- SupportXMR polling ----------

/**
 * Poll SupportXMR for the latest miner stats and worker data.
 * Stores the snapshot and allocates daily earnings.
 * Returns ['ok' => bool, ...] with status info.
 */
function doPoll(PDO $db): array {
    // Read settings
    $settings = $db->query("SELECT address, time_zone FROM settings WHERE id = 1")->fetch();
    if (!$settings || empty($settings['address'])) {
        return ['ok' => false, 'error' => 'No wallet configured'];
    }

    $address  = $settings['address'];
    $timeZone = $settings['time_zone'] ?: 'UTC';

    // ── Fetch miner stats ──
    $ch = curl_init('https://www.supportxmr.com/api/miner/' . urlencode($address) . '/stats');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 12,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_USERAGENT      => 'OreLog/1.0',
    ]);
    $body     = curl_exec($ch);
    $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr  = curl_error($ch);
    curl_close($ch);

    if ($body === false || $httpCode !== 200) {
        $err = $curlErr ?: "SupportXMR returned HTTP $httpCode";
        $db->prepare("UPDATE poll_state SET last_error = ? WHERE id = 1")->execute([$err]);
        return ['ok' => false, 'error' => $err];
    }

    $stats = json_decode($body, true, 512, JSON_BIGINT_AS_STRING);
    if (!isset($stats['amtDue']) || !isset($stats['amtPaid'])) {
        $err = 'SupportXMR did not return miner payment totals for this address';
        $db->prepare("UPDATE poll_state SET last_error = ? WHERE id = 1")->execute([$err]);
        return ['ok' => false, 'error' => $err];
    }

    $now        = gmdate('Y-m-d H:i:s');
    $pending    = toAtomic($stats['amtDue']);
    $paid       = toAtomic($stats['amtPaid']);
    $cumulative = bcadd($pending, $paid);
    $totalHash  = (string)max(0, intval($stats['totalHashes'] ?? 0));
    $lastHash   = max(0, intval($stats['lastHash'] ?? 0));

    // Insert snapshot
    $stmt = $db->prepare(
        "INSERT INTO snapshots (recorded_at, cumulative_atomic, pending_atomic, paid_atomic, total_hashes, last_hash_seconds)
         VALUES (?, ?, ?, ?, ?, ?)"
    );
    $stmt->execute([$now, $cumulative, $pending, $paid, $totalHash, $lastHash]);

    // ── Fetch active worker stats, chart hashrates & identifiers ──
    $wch = curl_init('https://www.supportxmr.com/api/miner/' . urlencode($address) . '/stats/allWorkers');
    curl_setopt_array($wch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 12,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_USERAGENT      => 'OreLog/1.0',
    ]);
    $wBody = curl_exec($wch);
    curl_close($wch);

    $cch = curl_init('https://www.supportxmr.com/api/miner/' . urlencode($address) . '/chart/hashrate/allWorkers');
    curl_setopt_array($cch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 12,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_USERAGENT      => 'OreLog/1.0',
    ]);
    $cBody = curl_exec($cch);
    curl_close($cch);

    $ich = curl_init('https://www.supportxmr.com/api/miner/' . urlencode($address) . '/identifiers');
    curl_setopt_array($ich, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 12,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_USERAGENT      => 'OreLog/1.0',
    ]);
    $iBody = curl_exec($ich);
    curl_close($ich);

    $chartMap = [];
    if ($cBody) {
        $chartMap = json_decode($cBody, true) ?: [];
    }

    $allWorkersMap = [];
    if ($wBody) {
        $parsedW = json_decode($wBody, true);
        if (is_array($parsedW)) {
            $isAssoc = array_keys($parsedW) !== range(0, count($parsedW) - 1);
            if ($isAssoc) {
                $allWorkersMap = $parsedW;
            } else {
                foreach ($parsedW as $idx => $item) {
                    $k = $item['identifer'] ?? $item['identifier'] ?? $item['name'] ?? ('worker-' . ($idx + 1));
                    $allWorkersMap[$k] = $item;
                }
            }
        }
    }

    $idents = [];
    if ($iBody) {
        $parsedI = json_decode($iBody, true);
        if (is_array($parsedI)) $idents = $parsedI;
    }

    // Read previous known workers
    $prevWorkersJson = $db->query("SELECT active_workers FROM poll_state WHERE id = 1")->fetchColumn();
    $knownWorkers = [];
    if ($prevWorkersJson) {
        $decoded = json_decode($prevWorkersJson, true);
        if (is_array($decoded)) {
            foreach ($decoded as $w) {
                if (isset($w['name'])) $knownWorkers[$w['name']] = $w;
            }
        }
    }

    $nowTs = time();
    $rawNames = array_unique(array_merge(
        $idents,
        array_keys($chartMap),
        array_keys($allWorkersMap)
    ));

    $namedWorkers = array_filter($rawNames, function($n) {
        return $n !== '' && $n !== 'global' && $n !== 'default';
    });

    if (!empty($namedWorkers)) {
        unset($knownWorkers['default']);
        unset($knownWorkers['global']);

        foreach ($namedWorkers as $wName) {
            $wStats = $allWorkersMap[$wName] ?? [];
            if (empty($wStats['totalHash']) && count($namedWorkers) <= 6) {
                $swch = curl_init('https://www.supportxmr.com/api/miner/' . urlencode($address) . '/stats/' . urlencode($wName));
                curl_setopt_array($swch, [
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT        => 5,
                    CURLOPT_CONNECTTIMEOUT => 3,
                    CURLOPT_USERAGENT      => 'OreLog/1.0',
                ]);
                $swBody = curl_exec($swch);
                curl_close($swch);
                if ($swBody) {
                    $swData = json_decode($swBody, true);
                    if (is_array($swData)) $wStats = array_merge($wStats, $swData);
                }
            }

            $chartPoints = $chartMap[$wName] ?? [];
            $latestPoint = (is_array($chartPoints) && !empty($chartPoints)) ? $chartPoints[0] : null;
            $latestChartHs = $latestPoint ? (float)($latestPoint['hs'] ?? 0) : 0;
            $instantHs = (float)($wStats['hashrate'] ?? $wStats['hash'] ?? $wStats['hash2'] ?? 0);
            $lastShare = (int)($wStats['lts'] ?? $wStats['lastShare'] ?? $wStats['last_share'] ?? $wStats['lastHash'] ?? (isset($latestPoint['ts']) ? (int)($latestPoint['ts'] / 1000) : $lastHash));
            $totalH = (int)($wStats['totalHash'] ?? $wStats['totalHashes'] ?? $wStats['hashes'] ?? (count($namedWorkers) === 1 ? (int)$totalHash : 0));
            $isRecent = $lastShare > 0 && ($nowTs - $lastShare) < 600;
            $hashrate = $isRecent ? ($instantHs > 0 ? instantHs : $latestChartHs) : 0;

            $prevLast = $knownWorkers[$wName]['lastShare'] ?? 0;
            $prevTot = $knownWorkers[$wName]['totalHashes'] ?? 0;

            $knownWorkers[$wName] = [
                'name'        => $wName,
                'hashrate'    => $hashrate,
                'lastShare'   => $lastShare > 0 ? $lastShare : $prevLast,
                'totalHashes' => $totalH > 0 ? $totalH : $prevTot,
            ];
        }
    } else if (empty($knownWorkers)) {
        $globalW = $allWorkersMap['global'] ?? [];
        $globalChart = $chartMap['global'] ?? [];
        $latestPoint = (is_array($globalChart) && !empty($globalChart)) ? $globalChart[0] : null;
        $latestChartHs = $latestPoint ? (float)($latestPoint['hs'] ?? 0) : 0;
        $instantHs = (float)($globalW['hashrate'] ?? $globalW['hash'] ?? $stats['hash'] ?? 0);
        $lastShare = (int)($globalW['lts'] ?? $globalW['lastShare'] ?? $stats['lastHash'] ?? 0);
        $totalH = (int)($globalW['totalHash'] ?? $globalW['totalHashes'] ?? $totalHash);
        $isRecent = $lastShare > 0 && ($nowTs - $lastShare) < 600;
        $hashrate = $isRecent ? ($instantHs > 0 ? instantHs : $latestChartHs) : 0;

        $knownWorkers['default'] = [
            'name'        => 'default',
            'hashrate'    => $hashrate,
            'lastShare'   => $lastShare,
            'totalHashes' => $totalH,
        ];
    }

    foreach ($knownWorkers as &$w) {
        $isRecent = ($w['lastShare'] ?? 0) > 0 && ($nowTs - $w['lastShare']) < 600;
        if (!$isRecent) {
            $w['hashrate'] = 0;
        }
    }
    unset($w);

    $activeWorkers = array_values($knownWorkers);

    // ── Daily allocation ──
    $prevStmt = $db->prepare(
        "SELECT recorded_at, cumulative_atomic FROM snapshots WHERE recorded_at < ? ORDER BY recorded_at DESC LIMIT 1"
    );
    $prevStmt->execute([$now]);
    $previous = $prevStmt->fetch();

    if ($previous) {
        $current = ['recorded_at' => $now, 'cumulative_atomic' => $cumulative];
        allocateDelta($db, $previous, $current, $timeZone);
    } else {
        initializeDay($db, timeZoneDayKey(time(), $timeZone), $now);
    }

    finalizeBefore($db, timeZoneDayKey(time(), $timeZone));

    // Update poll state with active workers json
    $db->prepare("UPDATE poll_state SET last_poll_at = ?, last_error = NULL, active_workers = ? WHERE id = 1")
       ->execute([$now, json_encode($activeWorkers)]);

    return ['ok' => true, 'recordedAt' => $now];
}

// ---------- Fiat currency conversion ----------

/**
 * Get current XMR prices in USD and INR with a 5-minute cache.
 */
function getFiatRates(PDO $db): array {
    $ps = $db->query("SELECT fiat_rates, fiat_fetched_at FROM poll_state WHERE id = 1")->fetch();
    $now = time();
    if ($ps && !empty($ps['fiat_rates']) && !empty($ps['fiat_fetched_at'])) {
        $elapsed = $now - strtotime($ps['fiat_fetched_at']);
        if ($elapsed < 300) {
            $cached = json_decode($ps['fiat_rates'], true);
            if (!empty($cached['usd']) && !empty($cached['inr'])) {
                return $cached;
            }
        }
    }

    $fiat = ['usd' => 0, 'inr' => 0];

    // 1. Try CoinGecko
    $ch = curl_init('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd,inr');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 6,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_USERAGENT      => 'OreLog/1.0',
    ]);
    $res = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($res && $code === 200) {
        $data = json_decode($res, true);
        if (!empty($data['monero']['usd']) && !empty($data['monero']['inr'])) {
            $fiat = [
                'usd' => (float)$data['monero']['usd'],
                'inr' => (float)$data['monero']['inr'],
            ];
        }
    }

    // 2. Fallback to CoinPaprika
    if (empty($fiat['usd'])) {
        $ch = curl_init('https://api.coinpaprika.com/v1/tickers/xmr-monero?quotes=USD,INR');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 6,
            CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_USERAGENT      => 'OreLog/1.0',
        ]);
        $res = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($res && $code === 200) {
            $data = json_decode($res, true);
            if (!empty($data['quotes']['USD']['price']) && !empty($data['quotes']['INR']['price'])) {
                $fiat = [
                    'usd' => (float)$data['quotes']['USD']['price'],
                    'inr' => (float)$data['quotes']['INR']['price'],
                ];
            }
        }
    }

    if (!empty($fiat['usd'])) {
        $db->prepare("UPDATE poll_state SET fiat_rates = ?, fiat_fetched_at = ? WHERE id = 1")
           ->execute([json_encode($fiat), gmdate('Y-m-d H:i:s')]);
    } elseif ($ps && !empty($ps['fiat_rates'])) {
        $fiat = json_decode($ps['fiat_rates'], true) ?: $fiat;
    }

    return $fiat;
}

// ---------- Response formatters ----------

/**
 * Format a snapshot DB row into the shape the React frontend expects.
 */
function formatSnapshot(?array $row): ?array {
    if (!$row) return null;
    return [
        'recordedAt'      => gmdate('Y-m-d\TH:i:s\Z', strtotime($row['recorded_at'])),
        'cumulativeAtomic' => $row['cumulative_atomic'],
        'pendingAtomic'    => $row['pending_atomic'],
        'paidAtomic'       => $row['paid_atomic'],
        'totalHashes'      => $row['total_hashes'],
        'lastHashSeconds'  => (int)$row['last_hash_seconds'],
    ];
}

/**
 * Format a daily_records row for the frontend.
 */
function formatDay(array $row): array {
    return [
        'dayKey'       => $row['day_key'],
        'earnedAtomic' => $row['earned_atomic'],
        'sampleCount'  => (int)$row['sample_count'],
        'gapCount'     => (int)$row['gap_count'],
        'finalized'    => (bool)$row['finalized'],
    ];
}

/**
 * Group flat worker_snapshot rows into the nested shape the frontend expects:
 *   [ { recordedAt, workers: [ { identifier, cumulativeAtomic } ] } ]
 */
function groupWorkerSnapshots(array $rows): array {
    $grouped = [];
    foreach ($rows as $row) {
        $at = gmdate('Y-m-d\TH:i:s\Z', strtotime($row['recorded_at']));
        if (!isset($grouped[$at])) {
            $grouped[$at] = ['recordedAt' => $at, 'workers' => []];
        }
        $grouped[$at]['workers'][] = [
            'identifier'      => $row['identifier'],
            'cumulativeAtomic' => $row['cumulative_atomic'],
        ];
    }
    return array_values($grouped);
}

/**
 * Downsample an array of formatted snapshots to one per time bucket.
 * Keeps the first and last items intact.
 */
function downsampleSnapshots(array $arr, int $bucketMs): array {
    if (count($arr) <= 2) return $arr;
    $first  = $arr[0];
    $last   = $arr[count($arr) - 1];
    $middle = array_slice($arr, 1, -1);

    $buckets = [];
    foreach ($middle as $item) {
        $at = strtotime($item['recordedAt']) * 1000;
        $bucket = intdiv((int)$at, $bucketMs);
        $buckets[$bucket] = $item;
    }
    return array_merge([$first], array_values($buckets), [$last]);
}

/**
 * Downsample grouped worker snapshot arrays.
 */
function downsampleWorkers(array $arr, int $bucketMs): array {
    if (count($arr) <= 2) return $arr;
    $first  = $arr[0];
    $last   = $arr[count($arr) - 1];
    $middle = array_slice($arr, 1, -1);

    $buckets = [];
    foreach ($middle as $item) {
        $at = strtotime($item['recordedAt']) * 1000;
        $bucket = intdiv((int)$at, $bucketMs);
        $buckets[$bucket] = $item;
    }
    return array_merge([$first], array_values($buckets), [$last]);
}
