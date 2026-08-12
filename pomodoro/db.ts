/**
 * ============================================================
 *  蕃茄鐘 · 資料層 (SQLite)
 * ============================================================
 *
 *  這一層只做「存取資料」,不碰 HTTP、也不碰 MCP。
 *  好處是 server.ts(REST)和未來任何介面都共用同一份查詢邏輯。
 *
 *  用的是 Node 內建的 node:sqlite(Node 22.5+),
 *  所以「不需要」npm install 任何資料庫套件。
 *  ⚠️ 它目前標記為 experimental,啟動時 Node 會印一行警告到 stderr,
 *     那是正常的(stderr 不影響 MCP stdio 協定)。
 * ============================================================
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

// ── 一筆蕃茄鐘紀錄長什麼樣子 ─────────────────────────────────
export type SessionKind = 'focus' | 'break';
export type SessionStatus = 'running' | 'completed' | 'aborted';
export type SessionSource = 'software' | 'device';

export interface Session {
  id: number;
  /**
   * 同一個蕃茄鐘的唯一識別碼,由「實體裝置」自己產生。
   * 這是整個實體整合最關鍵的欄位:裝置斷線重送時會帶同一個 session_uid,
   * 後端就知道「這是同一顆蕃茄,不要記兩次」(idempotency)。
   * 軟體端自己開的蕃茄鐘沒有這個值,為 NULL。
   */
  session_uid: string | null;
  source: SessionSource;
  device_id: string | null;
  task: string | null;
  kind: SessionKind;
  /** 原本打算專注幾秒(例如 25 分鐘 = 1500) */
  planned_seconds: number;
  /** 實際跑了幾秒;還在進行中時為 NULL */
  actual_seconds: number | null;
  status: SessionStatus;
  /** ISO8601 (UTC)。裝置回報的紀錄由後端「回推」算出,不信任裝置的時鐘 */
  started_at: string;
  ended_at: string | null;
  /** 這筆資料「實際被後端收到」的時間。跟 ended_at 比較就能看出補送延遲 */
  reported_at: string | null;
  created_at: string;
}

// ── 開啟(必要時建立)資料庫 ──────────────────────────────────
export function openDb(file: string): DatabaseSync {
  // 確保資料夾存在,不然 SQLite 會開檔失敗
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);

  // WAL 模式:讓「讀」跟「寫」不會互相卡住。
  // 我們有兩個 process 可能同時碰同一個檔(REST server 寫、其他工具讀),
  // 開 WAL 可以大幅減少 SQLITE_BUSY。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_uid     TEXT UNIQUE,
      source          TEXT    NOT NULL,
      device_id       TEXT,
      task            TEXT,
      kind            TEXT    NOT NULL,
      planned_seconds INTEGER NOT NULL,
      actual_seconds  INTEGER,
      status          TEXT    NOT NULL,
      started_at      TEXT    NOT NULL,
      ended_at        TEXT,
      reported_at     TEXT,
      created_at      TEXT    NOT NULL
    )
  `);
  // 查詢幾乎都是「某段時間範圍內的紀錄」,所以對 started_at 建索引
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at)');

  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 把「幾秒之前」換算成 ISO 時間字串(用於回推裝置事件的發生時間) */
export function isoSecondsAgo(seconds: number, from = Date.now()): string {
  return new Date(from - seconds * 1000).toISOString();
}

// ── 寫入:開始一個蕃茄鐘 ─────────────────────────────────────
export interface StartInput {
  source: SessionSource;
  kind: SessionKind;
  planned_seconds: number;
  task?: string | null;
  session_uid?: string | null;
  device_id?: string | null;
  started_at?: string;
}

export function insertRunning(db: DatabaseSync, input: StartInput): Session {
  const startedAt = input.started_at ?? nowIso();
  const stmt = db.prepare(`
    INSERT INTO sessions
      (session_uid, source, device_id, task, kind, planned_seconds,
       actual_seconds, status, started_at, ended_at, reported_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 'running', ?, NULL, ?, ?)
  `);
  const info = stmt.run(
    input.session_uid ?? null,
    input.source,
    input.device_id ?? null,
    input.task ?? null,
    input.kind,
    input.planned_seconds,
    startedAt,
    nowIso(),
    nowIso()
  );
  return getSession(db, Number(info.lastInsertRowid))!;
}

// ── 寫入:結束一個蕃茄鐘 ─────────────────────────────────────
export interface FinishInput {
  status: Exclude<SessionStatus, 'running'>;
  actual_seconds: number;
  ended_at: string;
  /** 可選:一併修正開始時間(見 server.ts 對「自我矛盾的紀錄」的處理) */
  started_at?: string;
}

/**
 * 只在「還在進行中」時才更新。
 * 這個 WHERE status = 'running' 條件很重要:
 * 裝置補送重複的結束事件時,第二次會更新到 0 筆,
 * 我們就知道「這顆蕃茄早就記過了」,不會把時數算兩次。
 *
 * @returns 更新後的紀錄;若已經結束過(或找不到)則回傳 null
 */
export function finishSession(
  db: DatabaseSync,
  id: number,
  input: FinishInput
): Session | null {
  // started_at 沒給就用 COALESCE 保留原值,一條 SQL 兼顧兩種情況
  const stmt = db.prepare(`
    UPDATE sessions
       SET status = ?, actual_seconds = ?, ended_at = ?, reported_at = ?,
           started_at = COALESCE(?, started_at)
     WHERE id = ? AND status = 'running'
  `);
  const info = stmt.run(
    input.status,
    input.actual_seconds,
    input.ended_at,
    nowIso(),
    input.started_at ?? null,
    id
  );
  if (info.changes === 0) return null;
  return getSession(db, id);
}

// ── 讀取 ────────────────────────────────────────────────────
export function getSession(db: DatabaseSync, id: number): Session | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  return (row as Session | undefined) ?? null;
}

export function getSessionByUid(db: DatabaseSync, uid: string): Session | null {
  const row = db.prepare('SELECT * FROM sessions WHERE session_uid = ?').get(uid);
  return (row as Session | undefined) ?? null;
}

export interface ListFilter {
  from?: string;
  to?: string;
  source?: SessionSource;
  status?: SessionStatus;
  kind?: SessionKind;
  limit?: number;
}

export function listSessions(db: DatabaseSync, filter: ListFilter = {}): Session[] {
  // 動態組 WHERE:每個條件都用 ? 佔位參數,不做字串拼接(避免 SQL injection)
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filter.from) {
    where.push('started_at >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('started_at < ?');
    params.push(filter.to);
  }
  if (filter.source) {
    where.push('source = ?');
    params.push(filter.source);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.kind) {
    where.push('kind = ?');
    params.push(filter.kind);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  params.push(filter.limit ?? 50);

  const rows = db
    .prepare(`SELECT * FROM sessions ${clause} ORDER BY started_at DESC LIMIT ?`)
    .all(...params);
  return rows as unknown as Session[];
}

export interface Stats {
  completed_focus_count: number;
  completed_focus_seconds: number;
  aborted_count: number;
  running_count: number;
  by_source: Record<string, number>;
  by_task: { task: string; count: number; seconds: number }[];
}

/** 統計某個時間範圍(半開區間 [from, to))的專注情況 */
export function getStats(db: DatabaseSync, from: string, to: string): Stats {
  const inRange = 'started_at >= ? AND started_at < ?';

  const focus = db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(actual_seconds), 0) AS s
         FROM sessions
        WHERE ${inRange} AND kind = 'focus' AND status = 'completed'`
    )
    .get(from, to) as { c: number; s: number };

  const aborted = db
    .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE ${inRange} AND status = 'aborted'`)
    .get(from, to) as { c: number };

  const running = db
    .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE ${inRange} AND status = 'running'`)
    .get(from, to) as { c: number };

  // 「軟體開的 vs 實體裝置開的」各幾顆 —— 這正是實體整合有沒有成功的證據
  const sources = db
    .prepare(
      `SELECT source, COUNT(*) AS c
         FROM sessions
        WHERE ${inRange} AND kind = 'focus' AND status = 'completed'
        GROUP BY source`
    )
    .all(from, to) as unknown as { source: string; c: number }[];

  const byTask = db
    .prepare(
      `SELECT COALESCE(task, '(未指定任務)') AS task,
              COUNT(*) AS count,
              COALESCE(SUM(actual_seconds), 0) AS seconds
         FROM sessions
        WHERE ${inRange} AND kind = 'focus' AND status = 'completed'
        GROUP BY task
        ORDER BY seconds DESC`
    )
    .all(from, to) as unknown as { task: string; count: number; seconds: number }[];

  return {
    completed_focus_count: focus.c,
    completed_focus_seconds: focus.s,
    aborted_count: aborted.c,
    running_count: running.c,
    by_source: Object.fromEntries(sources.map((r) => [r.source, r.c])),
    by_task: byTask,
  };
}
