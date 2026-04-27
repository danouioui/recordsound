import { useEffect, useMemo, useRef, useState } from 'react'

type NoiseEvent = {
  id: string
  startTime: string
  endTime: string
  durationSeconds: number
  averageDb: number
  peakDb: number
  burstCount: number
}

type ActiveEvent = {
  startMs: number
  aboveThresholdSamples: number[]
  peakDb: number
  burstCount: number
  inBurst: boolean
  burstAboveStartMs: number | null
  belowThresholdStartMs: number | null
}

const STORAGE_KEY = 'noise-log-events-v1'
const BURST_MIN_SECONDS = 0.5
const SILENCE_GAP_SECONDS = 2
const DEFAULT_THRESHOLD = 55

const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString([], {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}m ${secs}s`
}

const toCsv = (events: NoiseEvent[]) => {
  const header = [
    'start_time',
    'end_time',
    'duration_seconds',
    'average_db_above_threshold',
    'peak_db',
    'burst_count'
  ]

  const rows = events.map((event) => [
    event.startTime,
    event.endTime,
    event.durationSeconds.toFixed(2),
    event.averageDb.toFixed(1),
    event.peakDb.toFixed(1),
    event.burstCount
  ])

  return [header, ...rows]
    .map((row) => row.map((value) => `"${String(value).split('"').join('""')}"`).join(','))
    .join('\n')
}

function App() {
  const [hasPermission, setHasPermission] = useState<boolean | null>(null)
  const [isMonitoring, setIsMonitoring] = useState(false)
  const [currentDb, setCurrentDb] = useState(0)
  const [thresholdDb, setThresholdDb] = useState(DEFAULT_THRESHOLD)
  const [events, setEvents] = useState<NoiseEvent[]>([])

  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)

  const initialBurstStartRef = useRef<number | null>(null)
  const currentEventRef = useRef<ActiveEvent | null>(null)

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return

    try {
      const parsed = JSON.parse(saved) as NoiseEvent[]
      if (Array.isArray(parsed)) {
        setEvents(parsed)
      }
    } catch {
      // Ignore malformed storage payloads.
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events))
  }, [events])

  const todayEvents = useMemo(() => {
    const today = new Date()
    return events.filter((event) => {
      const start = new Date(event.startTime)
      return (
        start.getFullYear() === today.getFullYear() &&
        start.getMonth() === today.getMonth() &&
        start.getDate() === today.getDate()
      )
    })
  }, [events])

  const summary = useMemo(() => {
    const emptyByHour = Array.from({ length: 24 }, (_, hour) => ({ hour, events: 0, bursts: 0 }))

    if (!todayEvents.length) {
      return {
        totalEvents: 0,
        totalBursts: 0,
        averageDb: 0,
        peakDb: 0,
        byHour: emptyByHour
      }
    }

    const totalEvents = todayEvents.length
    const totalBursts = todayEvents.reduce((acc, event) => acc + event.burstCount, 0)
    const averageDb =
      todayEvents.reduce((acc, event) => acc + event.averageDb, 0) / Math.max(totalEvents, 1)
    const peakDb = Math.max(...todayEvents.map((event) => event.peakDb))

    const byHour = emptyByHour.map((item) => ({ ...item }))
    todayEvents.forEach((event) => {
      const hour = new Date(event.startTime).getHours()
      byHour[hour].events += 1
      byHour[hour].bursts += event.burstCount
    })

    return {
      totalEvents,
      totalBursts,
      averageDb,
      peakDb,
      byHour
    }
  }, [todayEvents])

  const resetRuntimeState = () => {
    initialBurstStartRef.current = null
    currentEventRef.current = null
  }

  const stopMonitoring = () => {
    setIsMonitoring(false)

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaStreamRef.current = null

    analyserRef.current = null

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      void audioContextRef.current.close()
    }
    audioContextRef.current = null

    resetRuntimeState()
  }

  const finalizeEvent = (eventData: ActiveEvent, endMs: number) => {
    const durationSeconds = Math.max(0, (endMs - eventData.startMs) / 1000)
    if (durationSeconds <= 0 || eventData.burstCount === 0 || !eventData.aboveThresholdSamples.length) {
      return
    }

    const averageDb =
      eventData.aboveThresholdSamples.reduce((acc, sample) => acc + sample, 0) /
      eventData.aboveThresholdSamples.length

    const newEvent: NoiseEvent = {
      id: crypto.randomUUID(),
      startTime: new Date(eventData.startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
      durationSeconds,
      averageDb,
      peakDb: eventData.peakDb,
      burstCount: eventData.burstCount
    }

    setEvents((prev) => [newEvent, ...prev])
  }

  const startGroupedEvent = (startMs: number, initialDb: number) => {
    currentEventRef.current = {
      startMs,
      aboveThresholdSamples: [initialDb],
      peakDb: initialDb,
      burstCount: 1,
      inBurst: true,
      burstAboveStartMs: null,
      belowThresholdStartMs: null
    }
  }

  const tick = () => {
    const analyser = analyserRef.current
    if (!analyser) return

    const timeData = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(timeData)

    let sumSquares = 0
    for (let i = 0; i < timeData.length; i++) {
      const normalized = ((timeData[i] ?? 128) - 128) / 128
      sumSquares += normalized * normalized
    }

    const rms = Math.sqrt(sumSquares / timeData.length)
    const estimatedDb = Math.max(0, Math.min(120, 20 * Math.log10(rms + 1e-8) + 100))
    setCurrentDb(estimatedDb)

    const now = Date.now()
    const isAboveThreshold = estimatedDb >= thresholdDb
    const active = currentEventRef.current

    if (!active) {
      if (isAboveThreshold) {
        if (initialBurstStartRef.current === null) {
          initialBurstStartRef.current = now
        }

        const aboveSeconds = (now - initialBurstStartRef.current) / 1000
        if (aboveSeconds >= BURST_MIN_SECONDS) {
          startGroupedEvent(initialBurstStartRef.current, estimatedDb)
          initialBurstStartRef.current = null
        }
      } else {
        initialBurstStartRef.current = null
      }

      rafRef.current = requestAnimationFrame(tick)
      return
    }

    if (isAboveThreshold) {
      active.belowThresholdStartMs = null

      if (!active.inBurst) {
        if (active.burstAboveStartMs === null) {
          active.burstAboveStartMs = now
        }

        const burstBuildUpSeconds = (now - active.burstAboveStartMs) / 1000
        if (burstBuildUpSeconds >= BURST_MIN_SECONDS) {
          active.inBurst = true
          active.burstCount += 1
          active.aboveThresholdSamples.push(estimatedDb)
          active.peakDb = Math.max(active.peakDb, estimatedDb)
          active.burstAboveStartMs = null
        }
      } else {
        active.aboveThresholdSamples.push(estimatedDb)
        active.peakDb = Math.max(active.peakDb, estimatedDb)
      }
    } else {
      if (active.inBurst) {
        active.inBurst = false
        active.burstAboveStartMs = null
        active.belowThresholdStartMs = now
      } else {
        if (active.belowThresholdStartMs === null) {
          active.belowThresholdStartMs = now
        }

        const silenceSeconds = (now - active.belowThresholdStartMs) / 1000
        if (silenceSeconds >= SILENCE_GAP_SECONDS) {
          const endedEvent = currentEventRef.current
          currentEventRef.current = null
          initialBurstStartRef.current = null

          if (endedEvent) {
            finalizeEvent(endedEvent, endedEvent.belowThresholdStartMs ?? now)
          }
        }
      }
    }

    rafRef.current = requestAnimationFrame(tick)
  }

  const startMonitoring = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      setHasPermission(true)
      setIsMonitoring(true)

      mediaStreamRef.current = stream
      const context = new AudioContext()
      audioContextRef.current = context

      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.8
      source.connect(analyser)
      analyserRef.current = analyser

      resetRuntimeState()
      tick()
    } catch {
      setHasPermission(false)
    }
  }

  useEffect(() => {
    return () => {
      stopMonitoring()
    }
  }, [])

  const exportCsv = () => {
    const csv = toCsv(events)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `noise-events-${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <main className="app">
      <header>
        <h1>Noise Logging MVP</h1>
        <p className="subtle">
          Estimated dB only (not a certified sound level meter). Use for pattern tracking, not legal
          or safety-critical measurement.
        </p>
      </header>

      <section className="card">
        <h2>Live Monitor</h2>
        <div className="metric">
          <span className="value">{currentDb.toFixed(1)} dB</span>
          <span className="label">Current estimate</span>
        </div>

        <label htmlFor="threshold">Threshold: {thresholdDb} dB</label>
        <input
          id="threshold"
          type="range"
          min={40}
          max={110}
          value={thresholdDb}
          onChange={(event) => setThresholdDb(Number(event.target.value))}
        />

        <div className="button-row">
          {!isMonitoring ? (
            <button onClick={startMonitoring}>Start Monitoring</button>
          ) : (
            <button className="danger" onClick={stopMonitoring}>
              Stop Monitoring
            </button>
          )}
          <button onClick={exportCsv} disabled={events.length === 0}>
            Export CSV
          </button>
        </div>

        {hasPermission === false && (
          <p className="error">
            Microphone permission denied. Allow microphone access in your browser settings.
          </p>
        )}

        <p className="subtle">
          Burst rule: above threshold for {BURST_MIN_SECONDS}s starts a burst. Grouped event closes only
          after {SILENCE_GAP_SECONDS}s of continuous silence below threshold.
        </p>
      </section>

      <section className="card">
        <h2>Today's Summary</h2>
        <div className="summary-grid">
          <div>
            <strong>{summary.totalEvents}</strong>
            <span>Noise events</span>
          </div>
          <div>
            <strong>{summary.totalBursts}</strong>
            <span>Bursts</span>
          </div>
          <div>
            <strong>{summary.averageDb.toFixed(1)} dB</strong>
            <span>Avg event dB</span>
          </div>
          <div>
            <strong>{summary.peakDb.toFixed(1)} dB</strong>
            <span>Peak dB</span>
          </div>
        </div>

        <h3>Events / Bursts by Hour</h3>
        <div className="hours-grid">
          {summary.byHour.map(({ hour, events: eventsCount, bursts }) => (
            <div key={hour} className="hour-item">
              <span>{hour.toString().padStart(2, '0')}:00</span>
              <strong>E:{eventsCount} / B:{bursts}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Event Log</h2>
        {events.length === 0 ? (
          <p className="subtle">No events recorded yet.</p>
        ) : (
          <div className="events-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Start</th>
                  <th>End</th>
                  <th>Duration</th>
                  <th>Avg dB</th>
                  <th>Peak dB</th>
                  <th>Bursts</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>{formatDateTime(event.startTime)}</td>
                    <td>{formatDateTime(event.endTime)}</td>
                    <td>{formatDuration(event.durationSeconds)}</td>
                    <td>{event.averageDb.toFixed(1)}</td>
                    <td>{event.peakDb.toFixed(1)}</td>
                    <td>{event.burstCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  )
}

export default App
