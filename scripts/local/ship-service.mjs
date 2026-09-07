import WebSocket from 'ws';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  SHIP_INTERVAL_MS,
  SHIP_WINDOW_MS,
  SHIP_MAX_RECORDS,
  SHIP_DISPLAY_LIMIT,
} from './ship-policy.mjs';
import {
  normalizeAisMessage,
  mergeShips,
  SHIP_MESSAGE_TYPES,
} from './ship-model.mjs';

// One connection per local OpenView server; no upstream connection is created per viewer.
export class ShipService {
  constructor({
    key = '',
    snapshotPath,
    fallback,
    now = Date.now,
    windowMs = SHIP_WINDOW_MS,
    socketFactory = (url, options) => new WebSocket(url, options),
  } = {}) {
    this.key = key;
    this.snapshotPath = snapshotPath;
    this.fallback = fallback;
    this.now = now;
    this.windowMs = windowMs;
    this.socketFactory = socketFactory;
    this.nextAttemptAt = 0;
    this.published = null;
    this.pending = null;
    this.cancelWindow = null;
    this.closed = false;
  }

  async initialize() {
    if (!this.snapshotPath) return;
    try {
      if ((await stat(this.snapshotPath)).size > 40 * 1024 * 1024) return;
      const saved = JSON.parse(await readFile(this.snapshotPath, 'utf8'));
      if (saved.version !== 1) return;
      const now = this.now();
      // Persisted cooldown prevents refresh spam and service restarts from opening extra windows.
      if (Number.isFinite(saved.nextAttemptAt))
        this.nextAttemptAt = Math.min(
          saved.nextAttemptAt,
          now + SHIP_INTERVAL_MS,
        );
      if (
        !Array.isArray(saved.snapshot?.items) ||
        !Number.isFinite(saved.snapshot.fetchedAt)
      )
        return;
      const rows = this.key
        ? saved.snapshot.items
        : saved.snapshot.items.filter((row) => row.source !== 'AISStream');
      const clean = mergeShips([], rows, now, SHIP_MAX_RECORDS);
      this.published = { ...saved.snapshot, items: clean.items };
      if (!this.key)
        Object.assign(this.published, {
          source: 'Fintraffic / Digitraffic · CC BY 4.0',
          sourceUrl: 'https://www.digitraffic.fi/en/marine-traffic/',
          coverage: 'Finnish coast and Baltic AIS receiver coverage',
          warning:
            'AISStream is not configured or is disabled. Showing regional reports.',
        });
    } catch {
      /* No usable prior snapshot. */
    }
  }

  async persist() {
    if (!this.snapshotPath) return;
    try {
      await mkdir(dirname(this.snapshotPath), { recursive: true });
      const temporary = this.snapshotPath + '.tmp';
      await writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          nextAttemptAt: this.nextAttemptAt,
          snapshot: this.published,
        }),
      );
      await rename(temporary, this.snapshotPath);
    } catch {
      /* A snapshot remains usable in memory if its local cache cannot be written. */
    }
  }

  collect() {
    if (this.closed)
      return Promise.resolve({
        items: [],
        warning: 'Ship collection stopped.',
      });
    if (!this.key)
      return Promise.resolve({
        items: [],
        warning:
          'AISStream is not configured. Showing regional Digitraffic reports.',
      });
    return new Promise((resolve) => {
      const positions = new Map(),
        details = new Map();
      let socket,
        done = false,
        confirmed = false,
        omitted = 0;
      const finish = (warning) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(authTimer);
        this.cancelWindow = null;
        // terminate guarantees no stream survives its bounded window, even on a broken close handshake.
        socket?.terminate();
        resolve({
          items: [...positions.values()].map((p) => ({
            ...p,
            ...details.get(p.id),
          })),
          omitted,
          warning:
            warning ||
            (!confirmed
              ? 'AISStream did not confirm the subscription. Retaining earlier reports.'
              : undefined),
        });
      };
      const timer = setTimeout(() => finish(), this.windowMs);
      const authTimer = setTimeout(
        () => {
          if (!confirmed)
            finish(
              'AISStream connection timed out. Retaining earlier reports.',
            );
        },
        Math.min(15000, this.windowMs),
      );
      this.cancelWindow = () => finish('Ship collection stopped.');
      try {
        socket = this.socketFactory('wss://stream.aisstream.io/v0/stream', {
          perMessageDeflate: true,
          handshakeTimeout: 10000,
          maxPayload: 1024 * 1024,
        });
        socket.on('open', () => {
          if (done) return;
          socket.send(
            JSON.stringify({
              APIKey: this.key,
              BoundingBoxes: [
                [
                  [-90, -180],
                  [90, 180],
                ],
              ],
              FilterMessageTypes: SHIP_MESSAGE_TYPES,
            }),
          );
        });
        socket.on('message', (bytes) => {
          if (done) return;
          try {
            const message = JSON.parse(bytes.toString('utf8'));
            if (message.error || message.Error) {
              finish(
                'AISStream rejected the subscription. Check its saved key and connection allowance.',
              );
              return;
            }
            if (message.MessageType === 'SubscriptionConfirmation') {
              if (message.Message?.CompressionEnabled !== true) {
                finish(
                  'AISStream did not enable compression. Collection paused.',
                );
                return;
              }
              confirmed = true;
              clearTimeout(authTimer);
              return;
            }
            if (!confirmed) return;
            const record = normalizeAisMessage(message, this.now());
            if (!record) return;
            const id = record.details.id;
            if (details.has(id) || details.size < SHIP_MAX_RECORDS)
              details.set(id, { ...details.get(id), ...record.details });
            if (record.position) {
              const previous = positions.get(id);
              if (previous && previous.observedAt >= record.position.observedAt)
                return;
              if (!previous && positions.size >= SHIP_MAX_RECORDS) {
                omitted++;
                return;
              }
              positions.set(id, record.position);
            }
          } catch {
            /* Isolate malformed messages without logging provider payloads. */
          }
        });
        socket.on('error', () =>
          finish('AISStream is unavailable. Retaining earlier reports.'),
        );
        socket.on('close', () =>
          finish('AISStream disconnected before the collection window ended.'),
        );
      } catch {
        finish('AISStream connection could not be opened.');
      }
    });
  }

  async refresh() {
    this.nextAttemptAt = this.now() + SHIP_INTERVAL_MS;
    await this.persist();
    const [ais, regional] = await Promise.all([
      this.collect(),
      Promise.resolve()
        .then(() => (this.closed ? null : this.fallback?.()))
        .catch(() => null),
    ]);
    const now = this.now();
    const fallback = (regional?.items || []).map((row) => ({
      ...row,
      source: regional.source,
      sourceUrl: regional.sourceUrl,
    }));
    const combined = mergeShips(
      this.published?.items || [],
      [...fallback, ...ais.items],
      now,
      SHIP_MAX_RECORDS,
    );
    const warnings = [
      ais.warning,
      !regional ? 'Digitraffic regional reports are unavailable.' : null,
    ];
    if (!ais.items.length && this.key && !ais.warning)
      warnings.push(
        'No AISStream positions were received in this sampling window.',
      );
    if (combined.omitted || ais.omitted)
      warnings.push(
        'The collection limit was reached; this snapshot is incomplete.',
      );
    this.published = {
      items: combined.items,
      fetchedAt: now,
      nextRefreshAt: this.nextAttemptAt,
      source: this.key
        ? 'AISStream + Fintraffic / Digitraffic'
        : 'Fintraffic / Digitraffic · CC BY 4.0',
      sourceUrl: this.key
        ? 'https://aisstream.io/'
        : 'https://www.digitraffic.fi/en/marine-traffic/',
      coverage: this.key
        ? 'Sampled worldwide AIS receiver coverage; gaps expected. Digitraffic supplements the Baltic region.'
        : 'Finnish coast and Baltic AIS receiver coverage',
      warning: warnings.filter(Boolean).join(' ') || undefined,
      omitted: combined.omitted + (ais.omitted || 0),
      collectionSeconds: this.key ? this.windowMs / 1000 : 0,
    };
    await this.persist();
    return this.published;
  }

  async snapshot() {
    if (this.closed) throw new Error('The ship service is stopped.');
    let cached = true;
    if (this.pending) await this.pending;
    else if (this.now() >= this.nextAttemptAt) {
      cached = false;
      this.pending = this.refresh().finally(() => {
        this.pending = null;
      });
      await this.pending;
    }
    const data = this.published || {
      items: [],
      fetchedAt: 0,
      source: 'AISStream',
      sourceUrl: 'https://aisstream.io/',
      warning: 'Waiting for the next collection window.',
    };
    const extra = Math.max(0, data.items.length - SHIP_DISPLAY_LIMIT);
    return {
      ...data,
      items: data.items.slice(0, SHIP_DISPLAY_LIMIT),
      omitted: (data.omitted || 0) + extra,
      warning:
        [
          data.warning,
          extra
            ? `Showing the ${SHIP_DISPLAY_LIMIT.toLocaleString()} most recent sampled vessels; additional reports are omitted.`
            : null,
        ]
          .filter(Boolean)
          .join(' ') || undefined,
      nextRefreshAt: this.nextAttemptAt,
      cached,
    };
  }

  async close() {
    this.closed = true;
    this.cancelWindow?.();
    await this.pending;
    this.key = '';
  }
}
