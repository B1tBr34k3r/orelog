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

  async getKnownWorkers() {
    try {
      return JSON.parse(await readFile(path.join(this.dir, 'known_workers.json'), 'utf8'))
    } catch {
      return []
    }
  }

  async saveKnownWorkers(workers) {
    try {
      await writeFile(path.join(this.dir, 'known_workers.json'), JSON.stringify(workers, null, 2))
    } catch {}
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
      await this.saveKnownWorkers([])
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

  async recentDays(limit = 365) {
    return [...this.memory.days].sort((a, b) => b.dayKey.localeCompare(a.dayKey)).slice(0, limit)
  }

  async deleteData(from, to, dayKey, isAll) {
    if (isAll) {
      this.memory.snapshots = []
      this.memory.workerSnapshots = []
      this.memory.days = []
      await writeFile(path.join(this.dir, 'snapshots.jsonl'), '')
      await writeFile(path.join(this.dir, 'worker_snapshots.jsonl'), '')
      await writeFile(path.join(this.dir, 'days.json'), '[]')
      return
    }
    if (from !== undefined && to !== undefined) {
      this.memory.snapshots = this.memory.snapshots.filter((s) => {
        const at = Date.parse(s.recordedAt)
        return at < from || at > to
      })
      this.memory.workerSnapshots = this.memory.workerSnapshots.filter((s) => {
        const at = Date.parse(s.recordedAt)
        return at < from || at > to
      })
      await writeFile(path.join(this.dir, 'snapshots.jsonl'), this.memory.snapshots.map((s) => JSON.stringify(s) + '\n').join(''))
      await writeFile(path.join(this.dir, 'worker_snapshots.jsonl'), this.memory.workerSnapshots.map((s) => JSON.stringify(s) + '\n').join(''))
    }
    if (dayKey) {
      this.memory.days = this.memory.days.filter((d) => d.dayKey !== dayKey)
      await this.saveDays()
    }
  }

  async getExportData(from, to, dayKey, isAll) {
    let snapshots = this.memory.snapshots
    let workerSnapshots = this.memory.workerSnapshots
    let days = this.memory.days
    if (!isAll && from !== undefined && to !== undefined) {
      snapshots = snapshots.filter((s) => {
        const at = Date.parse(s.recordedAt)
        return at >= from && at <= to
      })
      workerSnapshots = workerSnapshots.filter((s) => {
        const at = Date.parse(s.recordedAt)
        return at >= from && at <= to
      })
    }
    if (!isAll && dayKey) {
      days = days.filter((d) => d.dayKey === dayKey)
    }
    return {
      settings: this.memory.settings,
      snapshots,
      workerSnapshots,
      days,
    }
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

  async getKnownWorkers() {
    try {
      await this.pool.query('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT)')
      const { rows } = await this.pool.query("SELECT value FROM app_state WHERE key = 'known_workers'")
      return rows[0] ? JSON.parse(rows[0].value) : []
    } catch {
      return []
    }
  }

  async saveKnownWorkers(workers) {
    try {
      await this.pool.query('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT)')
      await this.pool.query(
        "INSERT INTO app_state (key, value) VALUES ('known_workers', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
        [JSON.stringify(workers)]
      )
    } catch {}
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

  async recentDays(limit = 365) {
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

  async deleteData(from, to, dayKey, isAll) {
    if (isAll) {
      await this.pool.query('TRUNCATE snapshots, worker_snapshots, daily_records')
      return
    }
    if (from !== undefined && to !== undefined) {
      const fromDate = new Date(from)
      const toDate = new Date(to)
      await this.pool.query('DELETE FROM snapshots WHERE recorded_at >= $1 AND recorded_at <= $2', [fromDate, toDate])
      await this.pool.query('DELETE FROM worker_snapshots WHERE recorded_at >= $1 AND recorded_at <= $2', [fromDate, toDate])
    }
    if (dayKey) {
      await this.pool.query('DELETE FROM daily_records WHERE day_key = $1', [dayKey])
    }
  }

  async getExportData(from, to, dayKey, isAll) {
    let snapQuery = 'SELECT * FROM snapshots ORDER BY recorded_at'
    let snapParams = []
    let workerQuery = 'SELECT * FROM worker_snapshots ORDER BY recorded_at'
    let workerParams = []
    let dayQuery = 'SELECT * FROM daily_records ORDER BY day_key'
    let dayParams = []

    if (!isAll && from !== undefined && to !== undefined) {
      snapQuery = 'SELECT * FROM snapshots WHERE recorded_at >= $1 AND recorded_at <= $2 ORDER BY recorded_at'
      snapParams = [new Date(from), new Date(to)]
      workerQuery = 'SELECT * FROM worker_snapshots WHERE recorded_at >= $1 AND recorded_at <= $2 ORDER BY recorded_at'
      workerParams = [new Date(from), new Date(to)]
    }
    if (!isAll && dayKey) {
      dayQuery = 'SELECT * FROM daily_records WHERE day_key = $1'
      dayParams = [dayKey]
    }

    const [settings, snapRes, workerRes, dayRes] = await Promise.all([
      this.getSettings(),
      this.pool.query(snapQuery, snapParams),
      this.pool.query(workerQuery, workerParams),
      this.pool.query(dayQuery, dayParams),
    ])

    const groupedWorkers = new Map()
    for (const row of workerRes.rows) {
      const at = new Date(row.recorded_at).toISOString()
      if (!groupedWorkers.has(at)) groupedWorkers.set(at, { recordedAt: at, workers: [] })
      groupedWorkers.get(at).workers.push({ identifier: row.identifier, cumulativeAtomic: String(row.cumulative_atomic) })
    }

    return {
      settings,
      snapshots: snapRes.rows.map((r) => this.mapSnapshot(r)),
      workerSnapshots: [...groupedWorkers.values()],
      days: dayRes.rows.map((r) => ({
        dayKey: r.day_key,
        earnedAtomic: String(r.earned_atomic),
        sampleCount: r.sample_count,
        gapCount: r.gap_count,
        firstAt: r.first_at ? new Date(r.first_at).toISOString() : null,
        lastAt: r.last_at ? new Date(r.last_at).toISOString() : null,
        finalized: r.finalized,
      })),
    }
  }
}

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null
const store = pool ? new PostgresStore(pool) : new JsonlStore()
const state = { lastPollAt: null, lastError: null, isPolling: false }
const knownWorkers = new Map()

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
  if (totalDelta <= 0n) return

  const start = Date.parse(previous.recordedAt)
  const end = Date.parse(current.recordedAt)
  const duration = end - start
  if (duration <= 0) return

  // If server was offline for more than 3 polling cycles, do not retroactively attribute offline delta
  if (duration > pollInterval * 3) {
    return
  }

  const currentKey = timeZoneDayKey(end, settings.timeZone)
  await store.addDaySample(currentKey, totalDelta, current.recordedAt, false)
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
    let workers = []
    let workerStats = []
    try {
      const [workerResponse, chartResponse, identResponse] = await Promise.all([
        fetch(`https://www.supportxmr.com/api/miner/${encodeURIComponent(settings.address)}/stats/allWorkers`, { signal: AbortSignal.timeout(12_000) }).catch(() => null),
        fetch(`https://www.supportxmr.com/api/miner/${encodeURIComponent(settings.address)}/chart/hashrate/allWorkers`, { signal: AbortSignal.timeout(12_000) }).catch(() => null),
        fetch(`https://www.supportxmr.com/api/miner/${encodeURIComponent(settings.address)}/identifiers`, { signal: AbortSignal.timeout(12_000) }).catch(() => null),
      ])

      let chartMap = {}
      if (chartResponse && chartResponse.ok) {
        try { chartMap = parseJson.parse(await chartResponse.text()) || {} } catch {}
      }

      let allWorkersMap = {}
      if (workerResponse && workerResponse.ok) {
        try {
          const body = parseJson.parse(await workerResponse.text()) || {}
          if (Array.isArray(body)) {
            for (let i = 0; i < body.length; i++) {
              const item = body[i]
              const k = item?.identifer || item?.identifier || item?.name || `worker-${i + 1}`
              allWorkersMap[k] = item
            }
          } else if (typeof body === 'object' && body !== null) {
            allWorkersMap = body
          }
        } catch {}
      }

      let idents = []
      if (identResponse && identResponse.ok) {
        try {
          const body = parseJson.parse(await identResponse.text())
          if (Array.isArray(body)) idents = body.map(String)
        } catch {}
      }

      const nowSec = Math.floor(Date.now() / 1000)
      const rawWorkerNames = new Set([
        ...idents,
        ...Object.keys(chartMap || {}),
        ...Object.keys(allWorkersMap || {}),
      ])

      const namedWorkers = Array.from(rawWorkerNames).filter((n) => n && n !== 'global' && n !== 'default')

      if (namedWorkers.length > 0) {
        if (knownWorkers.has('default')) knownWorkers.delete('default')
        if (knownWorkers.has('global')) knownWorkers.delete('global')

        for (const wName of namedWorkers) {
          let wStats = allWorkersMap[wName] || {}
          if (!wStats.totalHash && namedWorkers.length <= 6) {
            try {
              const singleRes = await fetch(`https://www.supportxmr.com/api/miner/${encodeURIComponent(settings.address)}/stats/${encodeURIComponent(wName)}`, { signal: AbortSignal.timeout(5000) })
              if (singleRes.ok) {
                const singleData = parseJson.parse(await singleRes.text()) || {}
                wStats = { ...wStats, ...singleData }
              }
            } catch {}
          }

          const chartPoints = chartMap[wName] || []
          const latestPoint = Array.isArray(chartPoints) && chartPoints.length > 0 ? chartPoints[0] : null
          const chartHs = latestPoint ? Number(latestPoint.hs || 0) : 0
          const instantHs = Number(wStats.hashrate ?? wStats.hash ?? wStats.hash2 ?? 0)
          const lastShare = Number(wStats.lts ?? wStats.lastShare ?? wStats.last_share ?? wStats.lastHash ?? (latestPoint ? Math.floor(latestPoint.ts / 1000) : stats.lastHash) ?? 0)
          const totalHashes = Number(wStats.totalHash ?? wStats.totalHashes ?? wStats.hashes ?? (namedWorkers.length === 1 ? stats.totalHashes : 0))
          const isRecent = lastShare > 0 && (nowSec - lastShare) < 600
          const hashrate = isRecent ? (instantHs > 0 ? instantHs : chartHs) : 0

          const existing = knownWorkers.get(wName)
          knownWorkers.set(wName, {
            name: wName,
            hashrate,
            lastShare: lastShare > 0 ? lastShare : (existing?.lastShare || 0),
            totalHashes: totalHashes > 0 ? totalHashes : (existing?.totalHashes || 0),
          })
        }
      } else if (knownWorkers.size === 0) {
        const globalW = allWorkersMap['global'] || {}
        const globalChart = chartMap['global'] || []
        const latestPoint = Array.isArray(globalChart) && globalChart.length > 0 ? globalChart[0] : null
        const chartHs = latestPoint ? Number(latestPoint.hs || 0) : 0
        const instantHs = Number(globalW.hashrate ?? globalW.hash ?? stats.hash ?? 0)
        const lastShare = Number(globalW.lts ?? globalW.lastShare ?? stats.lastHash ?? 0)
        const totalHashes = Number(globalW.totalHash ?? globalW.totalHashes ?? stats.totalHashes ?? 0)
        const isRecent = lastShare > 0 && (nowSec - lastShare) < 600
        const hashrate = isRecent ? (instantHs > 0 ? instantHs : chartHs) : 0

        knownWorkers.set('default', {
          name: 'default',
          hashrate,
          lastShare,
          totalHashes,
        })
      }

      // Update hashrates for all registered workers based on recency
      for (const [, w] of knownWorkers.entries()) {
        const isRecent = w.lastShare > 0 && (nowSec - w.lastShare) < 600
        if (!isRecent) {
          w.hashrate = 0
        }
      }

      workers = Array.from(knownWorkers.values())
      await store.saveKnownWorkers(workers)
      workerStats = workers.map((w) => ({
        identifier: w.name,
        cumulativeAtomic: '0',
      }))
    } catch (error) { console.warn('[workers] Unable to load worker stats:', error.message) }
    state.workers = workers
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

let cachedFiat = { usd: 0, inr: 0, lastFetched: 0 }

async function getFiatRates() {
  const now = Date.now()
  if (cachedFiat.usd > 0 && now - cachedFiat.lastFetched < 5 * 60 * 1000) {
    return cachedFiat
  }
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd,inr', {
      headers: { 'User-Agent': 'OreLog/1.0' },
      signal: AbortSignal.timeout(6000),
    })
    if (res.ok) {
      const data = await res.json()
      if (data?.monero?.usd && data?.monero?.inr) {
        cachedFiat = {
          usd: Number(data.monero.usd),
          inr: Number(data.monero.inr),
          lastFetched: now,
        }
        return cachedFiat
      }
    }
  } catch {}

  try {
    const res = await fetch('https://api.coinpaprika.com/v1/tickers/xmr-monero?quotes=USD,INR', {
      headers: { 'User-Agent': 'OreLog/1.0' },
      signal: AbortSignal.timeout(6000),
    })
    if (res.ok) {
      const data = await res.json()
      if (data?.quotes?.USD?.price && data?.quotes?.INR?.price) {
        cachedFiat = {
          usd: Number(data.quotes.USD.price),
          inr: Number(data.quotes.INR.price),
          lastFetched: now,
        }
        return cachedFiat
      }
    }
  } catch {}

  return cachedFiat
}

app.get('/healthz', (_request, response) => response.json({ ok: true }))

app.get('/api/data', async (request, response) => {
  try {
    const now = Date.now()
    const from = Number(request.query.from) || now - 24 * 60 * 60 * 1000
    const to = Math.min(now, Number(request.query.to) || now)
    if (to < from) return response.status(400).json({ error: 'End time must be after start time' })
    let [settings, latest, snapshots, workerSnapshots, days, fiat] = await Promise.all([
      store.getSettings(),
      store.latestSnapshot(),
      store.snapshotsBetween(from, to),
      store.workerSnapshotsBetween(from, to),
      store.recentDays(),
      getFiatRates(),
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

    response.json({ settings, latest, snapshots, workers: state.workers || [], workerSnapshots, days, fiat, collector: state, serverTime: new Date(now).toISOString() })
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
    if (reset) knownWorkers.clear()
    state.lastError = null
    await pollPool()
    response.json({ ok: true, reset })
  } catch (error) {
    response.status(500).json({ error: error.message || 'Unable to save settings' })
  }
})

app.get('/api/export', async (request, response) => {
  try {
    const scope = String(request.query.scope || 'all')
    const date = request.query.date ? String(request.query.date) : null
    const settings = await store.getSettings()
    const tz = settings?.timeZone || 'UTC'

    let from, to, dayKey, isAll = false
    if (scope === 'all') {
      isAll = true
    } else if (scope === 'today') {
      dayKey = timeZoneDayKey(Date.now(), tz)
      from = dayStartTimestamp(dayKey, tz)
      to = dayStartTimestamp(nextDayKey(dayKey), tz) - 1
    } else if (scope === 'date' && date) {
      dayKey = date
      from = dayStartTimestamp(dayKey, tz)
      to = dayStartTimestamp(nextDayKey(dayKey), tz) - 1
    } else {
      return response.status(400).json({ error: 'Invalid scope or date' })
    }

    const exportData = await store.getExportData(from, to, dayKey, isAll)
    const filename = `orelog-${scope}${date ? `-${date}` : ''}-${Date.now()}.json`
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    response.setHeader('Content-Type', 'application/json')
    response.send(JSON.stringify({ exportedAt: new Date().toISOString(), scope, date, ...exportData }, null, 2))
  } catch (error) {
    response.status(500).json({ error: error.message || 'Export failed' })
  }
})

app.delete('/api/data', async (request, response) => {
  try {
    const { scope, date } = request.body || {}
    const settings = await store.getSettings()
    const tz = settings?.timeZone || 'UTC'

    let from, to, dayKey, isAll = false
    if (scope === 'all') {
      isAll = true
    } else if (scope === 'today') {
      dayKey = timeZoneDayKey(Date.now(), tz)
      from = dayStartTimestamp(dayKey, tz)
      to = dayStartTimestamp(nextDayKey(dayKey), tz) - 1
    } else if (scope === 'date' && date) {
      dayKey = date
      from = dayStartTimestamp(dayKey, tz)
      to = dayStartTimestamp(nextDayKey(dayKey), tz) - 1
    } else {
      return response.status(400).json({ error: 'Invalid scope or date' })
    }

    await store.deleteData(from, to, dayKey, isAll)
    response.json({ ok: true, scope, date })
  } catch (error) {
    response.status(500).json({ error: error.message || 'Delete failed' })
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

try {
  const persisted = await store.getKnownWorkers()
  if (Array.isArray(persisted)) {
    for (const w of persisted) {
      if (w && w.name && w.name !== 'default' && w.name !== 'global') {
        knownWorkers.set(w.name, w)
      }
    }
  }
} catch {}

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
