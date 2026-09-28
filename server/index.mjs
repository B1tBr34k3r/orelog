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
const host = process.env.HOST || '0.0.0.0'
const pollInterval = 60_000
const retentionMs = 45 * 24 * 60 * 60 * 1000
const parseJson = JSONbig({ storeAsString: true })
const app = express()

app.use(express.json({ limit: '16kb' }))
import { appendFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import readline from 'node:readline'

class JsonlStore {
  constructor() {
    this.memory = { settings: null, snapshots: [], workerSnapshots: [], days: [] }
    this.dir = path.join(path.dirname(dataPath), 'jsonl')
  }

  async init() {
    await mkdir(this.dir, { recursive: true })
    try {
      this.memory.settings = JSON.parse(await readFile(path.join(this.dir, 'settings.json'), 'utf8'))
    } catch {}
    try {
      this.memory.days = JSON.parse(await readFile(path.join(this.dir, 'days.json'), 'utf8'))
    } catch {}
    
    await this.loadJsonl('snapshots.jsonl', this.memory.snapshots)
    await this.loadJsonl('worker_snapshots.jsonl', this.memory.workerSnapshots)
  }

  async loadJsonl(filename, array) {
    try {
      const stream = createReadStream(path.join(this.dir, filename))
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
      for await (const line of rl) {
        if (line.trim()) array.push(JSON.parse(line))
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(e)
    }
  }

  async getSettings() {
    return this.memory.settings
  }

  async saveSettings(settings) {
    const previous = this.memory.settings
    const reset = Boolean(previous && (previous.address !== settings.address || previous.timeZone !== settings.timeZone))
    this.memory.settings = settings
    await writeFile(path.join(this.dir, 'settings.json'), JSON.stringify(settings))
    
    if (reset) {
      this.memory.snapshots = []
      this.memory.workerSnapshots = []
      this.memory.days = []
      await writeFile(path.join(this.dir, 'snapshots.jsonl'), '')
      await writeFile(path.join(this.dir, 'worker_snapshots.jsonl'), '')
      await writeFile(path.join(this.dir, 'days.json'), '[]')
    }
    return reset
  }

  async latestSnapshot() {
    return this.memory.snapshots.at(-1) || null
  }

  async insertSnapshot(snapshot) {
    this.memory.snapshots.push(snapshot)
    await appendFile(path.join(this.dir, 'snapshots.jsonl'), JSON.stringify(snapshot) + '\n')
  }

  async snapshotsBetween(from, to) {
    const samples = this.memory.snapshots
    const before = [...samples].reverse().find(e => Date.parse(e.recordedAt) < from)
    const within = samples.filter(e => {
      const at = Date.parse(e.recordedAt)
      return at >= from && at <= to
    })
    const after = samples.find(e => Date.parse(e.recordedAt) > to)
    return [...(before ? [before] : []), ...within, ...(after ? [after] : [])]
  }

  async insertWorkerSnapshot(recordedAt, workers) {
    const snapshot = { recordedAt, workers }
    this.memory.workerSnapshots.push(snapshot)
    await appendFile(path.join(this.dir, 'worker_snapshots.jsonl'), JSON.stringify(snapshot) + '\n')
  }

  async workerSnapshotsBetween(from, to) {
    const samples = this.memory.workerSnapshots
    const before = [...samples].reverse().find(e => Date.parse(e.recordedAt) < from)
    const within = samples.filter(e => {
      const at = Date.parse(e.recordedAt)
      return at >= from && at <= to
    })
    const after = samples.find(e => Date.parse(e.recordedAt) > to)
    return [...(before ? [before] : []), ...within, ...(after ? [after] : [])]
  }

  async saveDays() {
    await writeFile(path.join(this.dir, 'days.json'), JSON.stringify(this.memory.days))
  }

  async addDaySample(dayKey, amountAtomic, recordedAt, gap) {
    let day = this.memory.days.find(d => d.dayKey === dayKey)
    if (!day) {
      day = { dayKey, earnedAtomic: '0', sampleCount: 0, gapCount: 0, firstAt: recordedAt }
      this.memory.days.push(day)
    }
    day.earnedAtomic = (BigInt(day.earnedAtomic) + BigInt(amountAtomic)).toString()
    day.sampleCount += 1
    day.gapCount += gap ? 1 : 0
    day.lastAt = recordedAt
    await this.saveDays()
  }

  async initializeDay(dayKey, recordedAt) {
    if (!this.memory.days.some(d => d.dayKey === dayKey)) {
      this.memory.days.push({ dayKey, earnedAtomic: '0', sampleCount: 0, gapCount: 0, firstAt: recordedAt, lastAt: recordedAt })
      await this.saveDays()
    }
  }

  async finalizeBefore(dayKey) {
    let changed = false
    for (const day of this.memory.days) {
      if (day.dayKey < dayKey && !day.finalized) {
        day.finalized = true
        changed = true
      }
    }
    if (changed) await this.saveDays()
  }

  async recentDays(limit = 31) {
    return [...this.memory.days].sort((a, b) => b.dayKey.localeCompare(a.dayKey)).slice(0, limit)
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
const store = pool ? new PostgresStore(pool) : new JsonlStore()
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
  console.info('[storage] Pure-JS JSONL database connected. Configured DATABASE_URL is empty.')
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
