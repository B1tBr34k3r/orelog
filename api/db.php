<?php
require_once __DIR__ . '/config.php';

/**
 * Returns a singleton PDO connection to the MySQL database.
 * Automatically initializes the schema on first call.
 */
function getDB(): PDO {
    static $pdo = null;
    if ($pdo !== null) return $pdo;

    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER,
        DB_PASS,
        [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]
    );

    ensureSchema($pdo);
    return $pdo;
}

/**
 * Creates all required tables if they don't already exist.
 * Uses a file-based flag so the heavy DDL only runs once.
 */
function ensureSchema(PDO $pdo): void {
    $flag = __DIR__ . '/.schema_ok';
    if (file_exists($flag)) return;

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS settings (
            id INT PRIMARY KEY DEFAULT 1,
            address VARCHAR(128) NOT NULL,
            time_zone VARCHAR(64) NOT NULL DEFAULT 'UTC'
        ) ENGINE=InnoDB;
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS snapshots (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            recorded_at DATETIME NOT NULL,
            cumulative_atomic VARCHAR(40) NOT NULL,
            pending_atomic VARCHAR(40) NOT NULL,
            paid_atomic VARCHAR(40) NOT NULL,
            total_hashes VARCHAR(40) NOT NULL DEFAULT '0',
            last_hash_seconds BIGINT NOT NULL DEFAULT 0,
            INDEX idx_recorded (recorded_at)
        ) ENGINE=InnoDB;
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS worker_snapshots (
            recorded_at DATETIME NOT NULL,
            identifier VARCHAR(128) NOT NULL,
            cumulative_atomic VARCHAR(40) NOT NULL,
            PRIMARY KEY (recorded_at, identifier),
            INDEX idx_ws_recorded (recorded_at)
        ) ENGINE=InnoDB;
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS daily_records (
            day_key VARCHAR(10) PRIMARY KEY,
            earned_atomic VARCHAR(40) NOT NULL DEFAULT '0',
            sample_count INT NOT NULL DEFAULT 0,
            gap_count INT NOT NULL DEFAULT 0,
            first_at DATETIME,
            last_at DATETIME,
            finalized TINYINT(1) NOT NULL DEFAULT 0
        ) ENGINE=InnoDB;
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS poll_state (
            id INT PRIMARY KEY DEFAULT 1,
            last_poll_at DATETIME,
            last_error TEXT,
            active_workers TEXT
        ) ENGINE=InnoDB;
    ");

    // Add active_workers column if upgrading an existing database
    try {
        $pdo->exec("ALTER TABLE poll_state ADD COLUMN active_workers TEXT");
    } catch (Exception $e) {
        // Column already exists
    }

    // Ensure poll_state row exists
    $pdo->exec("INSERT IGNORE INTO poll_state (id) VALUES (1)");

    @file_put_contents($flag, date('c'));
}
