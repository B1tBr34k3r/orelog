import express from 'express'
import { Pool } from 'pg'
import JSONbig from 'json-bigint'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataPath = path.join(root, 'data', 'records.json')
const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '127.0.0.1'
const pollInterval = 60_000
const retentionMs = 45 * 24 * 60 * 60 * 1000
const parseJson = JSONbig({ storeAsString: true })
const app = express()

app.use(express.json({ limit: '16kb' }))
import sqlite3 from 'sqlite3'
import { open } from 'sqlite'

class SqliteStore {
  async init() {
    await mkdir(path.dirname(dataPath), { recursive: true })
    this.db = await open({
      filename: dataPath.replace('.json', '.db'),
      driver: sqlite3.Database
    })
    
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS dashboard_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        address TEXT NOT NULL,
        time_zone TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at TEXT NOT NULL,
        cumulative_atomic TEXT NOT NULL,
        pending_atomic TEXT NOT NULL,
        paid_atomic TEXT NOT NULL,
        total_hashes TEXT NOT NULL,
        last_hash_seconds INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_recorded_at_idx ON snapshots (recorded_at);
      CREATE TABLE IF NOT EXISTS worker_snapshots (
        recorded_at TEXT NOT NULL,
        identifier TEXT NOT NULL,
        cumulative_atomic TEXT NOT NULL,
        PRIMARY KEY (recorded_at, identifier)
      );
      CREATE INDEX IF NOT EXISTS worker_snapshots_recorded_at_idx ON worker_snapshots (recorded_at);
      CREATE TABLE IF NOT EXISTS daily_records (
        day_key TEXT PRIMARY KEY,
        earned_atomic TEXT NOT NULL DEFAULT '0',
        sample_count INTEGER NOT NULL DEFAULT 0,
        gap_count INTEGER NOT NULL DEFAULT 0,
        first_at TEXT,
        last_at TEXT,
        finalized INTEGER NOT NULL DEFAULT 0
      );
    `)
  }

  mapSnapshot(row) {
    if (!row) return null
    return {
      recordedAt: row.recorded_at,
      cumulativeAtomic: row.cumulative_atomic,
      pendingAtomic: row.pending_atomic,
      paidAtomic: row.paid_atomic,
      totalHashes: row.total_hashes,
      lastHashSeconds: row.last_hash_seconds,
    }
  }

  async getSettings() {
    const row = await this.db.get('SELECT address, time_zone FROM dashboard_settings WHERE id = 1')
    return row ? { address: row.address, timeZone: row.time_zone } : null
  }

  async saveSettings(settings) {
    const previous = await this.getSettings()
    const reset = Boolean(previous && (previous.address !== settings.address || previous.timeZone !== settings.timeZone))
    
    await this.db.run('BEGIN TRANSACTION')
    try {
      await this.db.run(
        'INSERT INTO dashboard_settings (id, address, time_zone) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET address = excluded.address, time_zone = excluded.time_zone',
        [settings.address, settings.timeZone]
      )
      if (reset) {
        await this.db.run('DELETE FROM snapshots')
        await this.db.run('DELETE FROM sqlite_sequence WHERE name="snapshots"')
        await this.db.run('DELETE FROM worker_snapshots')
        await this.db.run('DELETE FROM daily_records')
      }
      await this.db.run('COMMIT')
    } catch (e) {
      await this.db.run('ROLLBACK')
      throw e
    }
    return reset
  }

  async latestSnapshot() {
    const row = await this.db.get('SELECT * FROM snapshots ORDER BY recorded_at DESC LIMIT 1')
    return this.mapSnapshot(row)
  }

  async insertSnapshot(snapshot) {
    await this.db.run(
      'INSERT INTO snapshots (recorded_at, cumulative_atomic, pending_atomic, paid_atomic, total_hashes, last_hash_seconds) VALUES (?, ?, ?, ?, ?, ?)',
      [snapshot.recordedAt, snapshot.cumulativeAtomic, snapshot.pendingAtomic, snapshot.paidAtomic, snapshot.totalHashes, snapshot.lastHashSeconds]
    )
  }

  async snapshotsBetween(from, to) {
    const fromStr = new Date(from).toISOString()
    const toStr = new Date(to).toISOString()
    
    const before = await this.db.get('SELECT * FROM snapshots WHERE recorded_at < ? ORDER BY recorded_at DESC LIMIT 1', [fromStr])
    const within = await this.db.all('SELECT * FROM snapshots WHERE recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at', [fromStr, toStr])
    const after = await this.db.get('SELECT * FROM snapshots WHERE recorded_at > ? ORDER BY recorded_at LIMIT 1', [toStr])
    
    return [
      ...(before ? [this.mapSnapshot(before)] : []),
      ...within.map(r => this.mapSnapshot(r)),
      ...(after ? [this.mapSnapshot(after)] : [])
    ]
  }

  async insertWorkerSnapshot(recordedAt, workers) {
    await this.db.run('BEGIN TRANSACTION')
    try {
      for (const worker of workers) {
        await this.db.run('INSERT INTO worker_snapshots (recorded_at, identifier, cumulative_atomic) VALUES (?, ?, ?)', [recordedAt, worker.identifier, worker.cumulativeAtomic])
      }
      await this.db.run('COMMIT')
    } catch (e) {
      await this.db.run('ROLLBACK')
      throw e
    }
  }

  async workerSnapshotsBetween(from, to) {
    const fromStr = new Date(from).toISOString()
    const toStr = new Date(to).toISOString()
    
    const before = await this.db.all('SELECT * FROM worker_snapshots WHERE recorded_at = (SELECT MAX(recorded_at) FROM worker_snapshots WHERE recorded_at < ?)', [fromStr])
    const within = await this.db.all('SELECT * FROM worker_snapshots WHERE recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at', [fromStr, toStr])
    const after = await this.db.all('SELECT * FROM worker_snapshots WHERE recorded_at = (SELECT MIN(recorded_at) FROM worker_snapshots WHERE recorded_at > ?)', [toStr])
    
    const grouped = new Map()
    for (const row of [...before, ...within, ...after]) {
      const at = row.recorded_at
      if (!grouped.has(at)) grouped.set(at, { recordedAt: at, workers: [] })
      grouped.get(at).workers.push({ identifier: row.identifier, cumulativeAtomic: String(row.cumulative_atomic) })
    }
    return [...grouped.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
  }

  async addDaySample(dayKey, amountAtomic, recordedAt, gap) {
    await this.db.run('BEGIN TRANSACTION')
    try {
      const row = await this.db.get('SELECT earned_atomic FROM daily_records WHERE day_key = ?', [dayKey])
      if (row) {
        const newEarned = (BigInt(row.earned_atomic) + amountAtomic).toString()
        await this.db.run('UPDATE daily_records SET earned_atomic = ?, sample_count = sample_count + 1, gap_count = gap_count + ?, last_at = ? WHERE day_key = ?', [newEarned, gap ? 1 : 0, recordedAt, dayKey])
      } else {
        await this.db.run('INSERT INTO daily_records (day_key, earned_atomic, sample_count, gap_count, first_at, last_at) VALUES (?, ?, 1, ?, ?, ?)', [dayKey, amountAtomic.toString(), gap ? 1 : 0, recordedAt, recordedAt])
      }
      await this.db.run('COMMIT')
    } catch(e) {
      await this.db.run('ROLLBACK')
      throw e
    }
  }

  async initializeDay(dayKey, recordedAt) {
    await this.db.run('INSERT INTO daily_records (day_key, first_at, last_at) VALUES (?, ?, ?) ON CONFLICT (day_key) DO NOTHING', [dayKey, recordedAt, recordedAt])
  }

  async finalizeBefore(dayKey) {
    await this.db.run('UPDATE daily_records SET finalized = 1 WHERE day_key < ? AND finalized = 0', [dayKey])
  }

  async recentDays(limit = 31) {
    const rows = await this.db.all('SELECT * FROM daily_records ORDER BY day_key DESC LIMIT ?', [limit])
    return rows.map(r => ({
      dayKey: r.day_key,
      earnedAtomic: r.earned_atomic,
      sampleCount: r.sample_count,
      gapCount: r.gap_count,
      firstAt: r.first_at,
      lastAt: r.last_at,
      finalized: Boolean(r.finalized)
    }))
  }
}

class PostgresStore {
  constructor(pool) {
    this.pool = pool
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS dashboard_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        address TEXT NOT NULL,
        time_zone TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id BIGSERIAL PRIMARY KEY,
        recorded_at TIMESTAMPTZ NOT NULL,
        cumulative_atomic NUMERIC(40, 0) NOT NULL,
        pending_atomic NUMERIC(40, 0) NOT NULL,
        paid_atomic NUMERIC(40, 0) NOT NULL,
        total_hashes NUMERIC(40, 0) NOT NULL,
        last_hash_seconds BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_recorded_at_idx ON snapshots (recorded_at);
      CREATE TABLE IF NOT EXISTS worker_snapshots (
        recorded_at TIMESTAMPTZ NOT NULL,
        identifier TEXT NOT NULL,
        cumulative_atomic NUMERIC(40, 0) NOT NULL,
        PRIMARY KEY (recorded_at, identifier)
      );
      CREATE INDEX IF NOT EXISTS worker_snapshots_recorded_at_idx ON worker_snapshots (recorded_at);
      CREATE TABLE IF NOT EXISTS daily_records (
        day_key TEXT PRIMARY KEY,
        earned_atomic NUMERIC(40, 0) NOT NULL DEFAULT 0,
        sample_count INTEGER NOT NULL DEFAULT 0,
        gap_count INTEGER NOT NULL DEFAULT 0,
        first_at TIMESTAMPTZ,
        last_at TIMESTAMPTZ,
        finalized BOOLEAN NOT NULL DEFAULT FALSE
      );
    `)
  }

  mapSnapshot(row) {
    if (!row) return null
    return {
      recordedAt: new Date(row.recorded_at).toISOString(),
      cumulativeAtomic: String(row.cumulative_atomic),
      pendingAtomic: String(row.pending_atomic),
      paidAtomic: String(row.paid_atomic),
      totalHashes: String(row.total_hashes),
      lastHashSeconds: Number(row.last_hash_seconds),
    }
  }

  async getSettings() {
    const { rows } = await this.pool.query('SELECT address, time_zone FROM dashboard_settings WHERE id = 1')
    return rows[0] ? { address: rows[0].address, timeZone: rows[0].time_zone } : null
  }

  async saveSettings(settings) {
    const previous = await this.getSettings()
    const reset = Boolean(previous && (
      previous.address !== settings.address || previous.timeZone !== settings.timeZone
    ))
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'INSERT INTO dashboard_settings (id, address, time_zone) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET address = EXCLUDED.address, time_zone = EXCLUDED.time_zone',
        [settings.address, settings.timeZone],
      )
      if (reset) {
        await client.query('TRUNCATE snapshots RESTART IDENTITY')
        await client.query('DELETE FROM worker_snapshots')
        await client.query('DELETE FROM daily_records')
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    return reset
  }

  async latestSnapshot() {
    const { rows } = await this.pool.query('SELECT * FROM snapshots ORDER BY recorded_at DESC LIMIT 1')
    return this.mapSnapshot(rows[0])
  }

  async insertSnapshot(snapshot) {
    await this.pool.query(
      'INSERT INTO snapshots (recorded_at, cumulative_atomic, pending_atomic, paid_atomic, total_hashes, last_hash_seconds) VALUES ($1, $2, $3, $4, $5, $6)',
      [snapshot.recordedAt, snapshot.cumulativeAtomic, snapshot.pendingAtomic, snapshot.paidAtomic, snapshot.totalHashes, snapshot.lastHashSeconds],
    )
  }

  async snapshotsBetween(from, to) {
    const [before, within, after] = await Promise.all([
      this.pool.query('SELECT * FROM snapshots WHERE recorded_at < $1 ORDER BY recorded_at DESC LIMIT 1', [new Date(from)]),
      this.pool.query('SELECT * FROM snapshots WHERE recorded_at >= $1 AND recorded_at <= $2 ORDER BY recorded_at', [new Date(from), new Date(to)]),
      this.pool.query('SELECT * FROM snapshots WHERE recorded_at > $1 ORDER BY recorded_at LIMIT 1', [new Date(to)]),
    ])
    return [
      ...(before.rows[0] ? [this.mapSnapshot(before.rows[0])] : []),
      ...within.rows.map((row) => this.mapSnapshot(row)),
      ...(after.rows[0] ? [this.mapSnapshot(after.rows[0])] : []),
    ]
  }

  async insertWorkerSnapshot(recordedAt, workers) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const worker of workers) await client.query('INSERT INTO worker_snapshots (recorded_at, identifier, cumulative_atomic) VALUES ($1, $2, $3)', [recordedAt, worker.identifier, worker.cumulativeAtomic])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async workerSnapshotsBetween(from, to) {
    const [before, within, after] = await Promise.all([
      this.pool.query('SELECT * FROM worker_snapshots WHERE recorded_at < $1 ORDER BY recorded_at DESC LIMIT 1', [new Date(from)]),
      this.pool.query('SELECT * FROM worker_snapshots WHERE recorded_at >= $1 AND recorded_at <= $2 ORDER BY recorded_at', [new Date(from), new Date(to)]),
      this.pool.query('SELECT * FROM worker_snapshots WHERE recorded_at > $1 ORDER BY recorded_at LIMIT 1', [new Date(to)]),
    ])
    const grouped = new Map()
    for (const row of [...before.rows, ...within.rows, ...after.rows]) {
      const recordedAt = new Date(row.recorded_at).toISOString()
      if (!grouped.has(recordedAt)) grouped.set(recordedAt, { recordedAt, workers: [] })
      grouped.get(recordedAt).workers.push({ identifier: row.identifier, cumulativeAtomic: String(row.cumulative_atomic) })
    }
    return [...grouped.values()]
  }

  async addDaySample(dayKey, amountAtomic, recordedAt, gap) {
    await this.pool.query(`
      INSERT INTO daily_records (day_key, earned_atomic, sample_count, gap_count, first_at, last_at)
      VALUES ($1, $2, 1, $3, $4, $4)
      ON CONFLICT (day_key) DO UPDATE SET
        earned_atomic = daily_records.earned_atomic + EXCLUDED.earned_atomic,
        sample_count = daily_records.sample_count + 1,
        gap_count = daily_records.gap_count + EXCLUDED.gap_count,
        last_at = EXCLUDED.last_at
    `, [dayKey, amountAtomic.toString(), gap ? 1 : 0, recordedAt])
  }

  async initializeDay(dayKey, recordedAt) {
    await this.pool.query(
      'INSERT INTO daily_records (day_key, first_at, last_at) VALUES ($1, $2, $2) ON CONFLICT (day_key) DO NOTHING',
      [dayKey, recordedAt],
    )
  }

  async finalizeBefore(dayKey) {
    await this.pool.query('UPDATE daily_records SET finalized = TRUE WHERE day_key < $1', [dayKey])
  }

  async recentDays(limit = 31) {
    const { rows } = await this.pool.query(
      'SELECT day_key, earned_atomic, sample_count, gap_count, first_at, last_at, finalized FROM daily_records ORDER BY day_key DESC LIMIT $1',
      [limit],
    )
    return rows.map((row) => ({
      dayKey: row.day_key,
      earnedAtomic: String(row.earned_atomic),
      sampleCount: row.sample_count,
      gapCount: row.gap_count,
      firstAt: row.first_at ? new Date(row.first_at).toISOString() : null,
      lastAt: row.last_at ? new Date(row.last_at).toISOString() : null,
      finalized: row.finalized,
    }))
  }
}

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null
const store = pool ? new PostgresStore(pool) : new SqliteStore()
const state = { lastPollAt: null, lastError: null, isPolling: false }

function timeZoneDayKey(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function nextDayKey(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number)
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
}

function dayStartTimestamp(dayKey, timeZone) {
  const [year, month, day] = dayKey.split('-').map(Number)
  const target = Date.UTC(year, month - 1, day)
  let guess = target
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(guess))
    const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]))
    const represented = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second)
    guess += target - represented
  }
  return guess
}

async function allocateDelta(previous, current, settings) {
  const totalDelta = BigInt(current.cumulativeAtomic) - BigInt(previous.cumulativeAtomic)
  let remaining = totalDelta
  if (remaining <= 0n) return

  const start = Date.parse(previous.recordedAt)
  const end = Date.parse(current.recordedAt)
  const duration = end - start
  if (duration <= 0) return
  const gap = duration > pollInterval * 3
  let cursor = start

  while (cursor < end) {
    const key = timeZoneDayKey(cursor, settings.timeZone)
    const boundary = dayStartTimestamp(nextDayKey(key), settings.timeZone)
    const segmentEnd = Math.min(end, boundary)
    const segmentDuration = BigInt(segmentEnd - cursor)
    const amount = segmentEnd === end ? remaining : (totalDelta * segmentDuration) / BigInt(duration)
    await store.addDaySample(key, amount, current.recordedAt, gap)
    remaining -= amount
    cursor = segmentEnd
  }
}

function toAtomic(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value).toString()
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Pool returned an invalid XMR balance')
  return BigInt(Math.round(amount)).toString()
}

async function pollPool() {
  if (state.isPolling) return
  state.isPolling = true
  try {
    const settings = await store.getSettings()
    if (!settings?.address) return

    const url = `https://www.supportxmr.com/api/miner/${encodeURIComponent(settings.address)}/stats`
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) })
    if (!response.ok) throw new Error(`SupportXMR returned HTTP ${response.status}`)
    const stats = parseJson.parse(await response.text())
    if (!stats || typeof stats.amtDue === 'undefined' || typeof stats.amtPaid === 'undefined') {
      throw new Error('SupportXMR did not return miner payment totals for this address')
    }

    const recordedAt = new Date().toISOString()
    const pendingAtomic = toAtomic(stats.amtDue)
    const paidAtomic = toAtomic(stats.amtPaid)
    const snapshot = {
      recordedAt,
      pendingAtomic,
      paidAtomic,
      cumulativeAtomic: (BigInt(pendingAtomic) + BigInt(paidAtomic)).toString(),
      totalHashes: String(Math.max(0, Number(stats.totalHashes) || 0)),
      lastHashSeconds: Math.max(0, Number(stats.lastHash) || 0),
    }
    let workerStats = []
    try {
      const workerResponse = await fetch(`https://www.supportxmr.com/api/miner/${encodeURIComponent(settings.address)}/stats/allWorkers`, { signal: AbortSignal.timeout(12_000) })
      if (workerResponse.ok) {
        const body = parseJson.parse(await workerResponse.text())
        const entries = Array.isArray(body) ? body : Object.entries(body || {}).map(([identifier, value]) => ({ identifier, ...value }))
        workerStats = entries.filter((worker) => worker && typeof worker === 'object').map((worker, index) => ({
          identifier: String(worker.identifier ?? worker.id ?? worker.worker ?? (entries.length === 1 ? 'default' : `worker-${index + 1}`)) || 'default',
          cumulativeAtomic: (BigInt(toAtomic(worker.amtDue ?? 0)) + BigInt(toAtomic(worker.amtPaid ?? 0))).toString(),
        }))
      }
    } catch (error) { console.warn('[workers] Unable to load worker stats:', error.message) }
    const previous = await store.latestSnapshot()
    await store.insertSnapshot(snapshot)
    if (workerStats.length) await store.insertWorkerSnapshot(recordedAt, workerStats)
    if (previous) await allocateDelta(previous, snapshot, settings)
    else await store.initializeDay(timeZoneDayKey(Date.now(), settings.timeZone), recordedAt)
    await store.finalizeBefore(timeZoneDayKey(Date.now(), settings.timeZone))
    state.lastPollAt = recordedAt
    state.lastError = null
  } catch (error) {
    state.lastError = error.message || 'Unable to contact SupportXMR'
    console.error('[collector]', state.lastError)
  } finally {
    state.isPolling = false
  }
}

app.get('/healthz', (_request, response) => response.json({ ok: true }))

app.get('/api/data', async (request, response) => {
  try {
    const now = Date.now()
    const from = Number(request.query.from) || now - 24 * 60 * 60 * 1000
    const to = Math.min(now, Number(request.query.to) || now)
    if (to < from) return response.status(400).json({ error: 'End time must be after start time' })
    let [settings, latest, snapshots, workerSnapshots, days] = await Promise.all([
      store.getSettings(),
      store.latestSnapshot(),
      store.snapshotsBetween(from, to),
      store.workerSnapshotsBetween(from, to),
      store.recentDays(),
    ])
    
    const duration = to - from
    if (duration > 24 * 60 * 60 * 1000) {
      const bucketBy = duration > 7 * 24 * 60 * 60 * 1000 ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000
      
      const downsample = (arr) => {
        if (arr.length <= 2) return arr
        const first = arr[0]
        const last = arr[arr.length - 1]
        const middle = arr.slice(1, -1)
        
        const buckets = new Map()
        for (const item of middle) {
          const at = Date.parse(item.recordedAt)
          const bucket = Math.floor(at / bucketBy)
          buckets.set(bucket, item)
        }
        return [first, ...Array.from(buckets.values()), last]
      }
      
      snapshots = downsample(snapshots)
      workerSnapshots = downsample(workerSnapshots)
    }

    response.json({ settings, latest, snapshots, workerSnapshots, days, collector: state, serverTime: new Date(now).toISOString() })
  } catch (error) {
    response.status(500).json({ error: error.message || 'Unable to load dashboard data' })
  }
})

app.put('/api/settings', async (request, response) => {
  try {
    const address = String(request.body?.address || '').trim()
    const timeZone = String(request.body?.timeZone || 'UTC')
    if (!/^[48][A-Za-z0-9]{94,105}$/.test(address)) {
      return response.status(400).json({ error: 'Enter a valid standard Monero address' })
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format()
    } catch {
      return response.status(400).json({ error: 'Enter a valid IANA time zone, such as Europe/London' })
    }
    const reset = await store.saveSettings({ address, timeZone })
    state.lastError = null
    await pollPool()
    response.json({ ok: true, reset })
  } catch (error) {
    response.status(500).json({ error: error.message || 'Unable to save settings' })
  }
})

if (pool) {
  await store.init()
  await pool.query('SELECT 1')
  console.info('[storage] PostgreSQL connected')
} else {
  await store.init()
  console.info('[storage] SQLite local database connected. Configured DATABASE_URL is empty.')
}

const builtClient = path.join(root, 'dist')
app.use(express.static(builtClient))
app.get('/{*path}', (request, response, next) => {
  if (request.path.startsWith('/api/') || request.path === '/healthz') return next()
  response.sendFile(path.join(builtClient, 'index.html'), (error) => error && next(error))
})

const server = app.listen(port, host, async () => {
  console.info(`[server] listening on ${port}`)
  await pollPool()
  setInterval(pollPool, pollInterval)
})

async function shutdown() {
  server.close()
  if (pool) await pool.end()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
