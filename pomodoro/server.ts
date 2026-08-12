/**
 * ============================================================
 *  蕃茄鐘 · 常駐後端 (Express + SQLite)
 * ============================================================
 *
 *  ❓ 為什麼需要這一支?MCP server 不能直接收裝置事件嗎?
 *
 *  不能。既有的 procurement MCP server 走的是 stdio,意思是:
 *    (1) 它「只在 Claude Desktop 開著時」才活著
 *    (2) 它沒有對外的網路 port,ESP32 根本連不進來
 *
 *  但實體蕃茄鐘走完時間的那一刻,你可能根本沒開 Claude。
 *  所以事件必須送給一個「一直開著、有 port」的服務 —— 就是這一支。
 *
 *    實體裝置 ──HTTP──▶ 本 server + SQLite ──讀取──▶ MCP server ──▶ Claude
 *      (ESP32)            (紀錄的唯一真相)          (mcp.ts)
 *
 *  本 server 提供兩組 API:
 *    /api/device/*    給實體裝置用(用 X-Device-Token 認證)
 *    /api/pomodoro/*  給軟體端 / MCP 用
 * ============================================================
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import {
  openDb,
  insertRunning,
  finishSession,
  getSession,
  getSessionByUid,
  listSessions,
  getStats,
  nowIso,
  isoSecondsAgo,
  type SessionKind,
} from './db.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .env 放在專案根目錄(pomodoro/ 的上一層),跟既有的採購設定共用一個檔
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const PORT = Number(process.env.POMODORO_PORT ?? 3101);
const DB_FILE =
  process.env.POMODORO_DB_FILE ?? path.join(__dirname, 'data', 'pomodoro.db');
/**
 * 裝置用的共用密鑰。ESP32 每次 POST 都要帶 X-Device-Token。
 * 這不是什麼高強度的認證,但至少讓「同一個 Wi-Fi 下的其他人」
 * 不能隨便塞假紀錄進你的資料庫。務必設定,不要留空。
 */
const DEVICE_TOKEN = process.env.POMODORO_DEVICE_TOKEN ?? '';
/**
 * 你所在時區相對 UTC 的偏移小時數(台北 = 8)。
 * 資料一律以 UTC 存,但「今天做了幾顆蕃茄」必須用當地時間切日界線,
 * 否則台灣時間早上 8 點前的紀錄會被算到前一天去。
 */
const UTC_OFFSET_HOURS = Number(process.env.POMODORO_UTC_OFFSET_HOURS ?? 8);

const DEFAULT_FOCUS_SECONDS = 25 * 60;

function log(...args: unknown[]) {
  console.error('[pomodoro-api]', ...args);
}

const db = openDb(DB_FILE);
const app = express();
app.use(express.json());

// ── 時間工具:用當地時區算出「今天 / 本週」的 UTC 區間 ─────────
function localDayStart(daysAgo = 0): string {
  const offsetMs = UTC_OFFSET_HOURS * 3600_000;
  // 先把「現在」平移到當地時間,截到當天 00:00,再平移回 UTC
  const localNow = new Date(Date.now() + offsetMs);
  const localMidnight = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate() - daysAgo
  );
  return new Date(localMidnight - offsetMs).toISOString();
}

function resolvePeriod(period: string): { from: string; to: string; label: string } {
  switch (period) {
    case 'today':
      return { from: localDayStart(0), to: nowIso(), label: '今天' };
    case 'yesterday':
      return { from: localDayStart(1), to: localDayStart(0), label: '昨天' };
    case 'week':
      return { from: localDayStart(6), to: nowIso(), label: '最近 7 天' };
    case 'all':
      return { from: '1970-01-01T00:00:00.000Z', to: nowIso(), label: '全部' };
    default:
      return { from: localDayStart(0), to: nowIso(), label: '今天' };
  }
}

// ── 裝置認證 middleware ─────────────────────────────────────
function requireDeviceToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (!DEVICE_TOKEN) {
    // 沒設密鑰就直接拒絕,而不是「預設放行」——
    // 免得你以為有保護、其實整個 API 是開放的。
    res.status(500).json({
      error: '伺服器尚未設定 POMODORO_DEVICE_TOKEN,拒絕接受裝置事件',
    });
    return;
  }
  if (req.header('X-Device-Token') !== DEVICE_TOKEN) {
    res.status(401).json({ error: 'X-Device-Token 不正確' });
    return;
  }
  next();
}

// ── 健康檢查 ────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'pomodoro-api',
    timestamp: nowIso(),
    device_token_configured: DEVICE_TOKEN.length > 0,
    db_file: DB_FILE,
  });
});

// ============================================================
//  A. 軟體端蕃茄鐘 API
// ============================================================

/** 開始一顆軟體蕃茄鐘 */
app.post('/api/pomodoro/sessions', (req, res) => {
  const { task, minutes, kind } = req.body ?? {};
  const plannedSeconds =
    typeof minutes === 'number' && minutes > 0
      ? Math.round(minutes * 60)
      : DEFAULT_FOCUS_SECONDS;

  const session = insertRunning(db, {
    source: 'software',
    kind: kind === 'break' ? 'break' : 'focus',
    planned_seconds: plannedSeconds,
    task: typeof task === 'string' && task.trim() !== '' ? task.trim() : null,
  });
  log(`軟體端開始蕃茄鐘 #${session.id}(${plannedSeconds}s)`);
  res.status(201).json({ session });
});

/** 結束一顆蕃茄鐘(completed = 走完;aborted = 中途放棄) */
app.post('/api/pomodoro/sessions/:id/finish', (req, res) => {
  const id = Number(req.params.id);
  const existing = getSession(db, id);
  if (!existing) {
    res.status(404).json({ error: `找不到蕃茄鐘紀錄 #${id}` });
    return;
  }
  if (existing.status !== 'running') {
    res.status(409).json({
      error: `蕃茄鐘 #${id} 已經是 ${existing.status} 狀態,不能重複結束`,
      session: existing,
    });
    return;
  }

  const status = req.body?.status === 'aborted' ? 'aborted' : 'completed';
  // 實際秒數以「後端記的開始時間」算,不接受呼叫端自己報一個數字
  const elapsed = Math.max(
    0,
    Math.round((Date.now() - new Date(existing.started_at).getTime()) / 1000)
  );
  const session = finishSession(db, id, {
    status,
    actual_seconds: elapsed,
    ended_at: nowIso(),
  });
  res.json({ session });
});

/** 查詢紀錄 */
app.get('/api/pomodoro/sessions', (req, res) => {
  const { from, to, source, status, kind, limit } = req.query;
  const sessions = listSessions(db, {
    from: typeof from === 'string' ? from : undefined,
    to: typeof to === 'string' ? to : undefined,
    source: source === 'device' || source === 'software' ? source : undefined,
    status:
      status === 'running' || status === 'completed' || status === 'aborted'
        ? status
        : undefined,
    kind: kind === 'focus' || kind === 'break' ? kind : undefined,
    limit: typeof limit === 'string' ? Number(limit) : undefined,
  });
  res.json({ sessions });
});

/** 統計 */
app.get('/api/pomodoro/stats', (req, res) => {
  const period = typeof req.query.period === 'string' ? req.query.period : 'today';
  const { from, to, label } = resolvePeriod(period);
  res.json({ period: label, from, to, stats: getStats(db, from, to) });
});

// ============================================================
//  B. 實體裝置 API —— 這是整個整合的核心
// ============================================================

/**
 * 實體蕃茄鐘回報事件。
 *
 *  body: {
 *    session_uid:     string   裝置為「這一顆蕃茄」產生的唯一 id(重送時不變)
 *    type:            'started' | 'completed' | 'aborted'
 *    device_id?:      string
 *    kind?:           'focus' | 'break'
 *    planned_seconds?: number
 *    elapsed_seconds?: number  這顆蕃茄實際跑了幾秒(結束事件用)
 *    age_seconds?:     number  這個事件是「幾秒前」發生的(離線補送用)
 *    task?:           string
 *  }
 *
 *  ⚠️ 三個刻意的設計,都是為了對付真實硬體的毛病:
 *
 *  (1) 不信任裝置的時鐘。ESP32 沒有電池供電的 RTC,斷電重開後時間會歸零,
 *      所以我們不收「絕對時間」,只收「相對秒數」,由後端蓋上真正的時間戳。
 *
 *  (2) session_uid 做去重。Wi-Fi 不穩時裝置會重送同一個事件,
 *      有了 uid + 「只更新 running 狀態」的條件,同一顆蕃茄只會被記一次。
 *
 *  (3) 允許「只有結束事件、沒有開始事件」。裝置離線時開始的蕃茄,
 *      開始事件根本沒送出去,恢復連線後只會補送結束事件 ——
 *      這種情況我們用 elapsed_seconds 回推開始時間,補一筆完整紀錄。
 */
app.post('/api/device/events', requireDeviceToken, (req, res) => {
  const {
    session_uid: sessionUid,
    type,
    device_id: deviceId,
    kind,
    planned_seconds: plannedSeconds,
    elapsed_seconds: elapsedSeconds,
    age_seconds: ageSeconds,
    task,
  } = req.body ?? {};

  if (typeof sessionUid !== 'string' || sessionUid.trim() === '') {
    res.status(400).json({ error: 'session_uid 必填(字串)' });
    return;
  }
  if (type !== 'started' && type !== 'completed' && type !== 'aborted') {
    res.status(400).json({ error: "type 必須是 'started' / 'completed' / 'aborted'" });
    return;
  }

  const sessionKind: SessionKind = kind === 'break' ? 'break' : 'focus';
  const planned =
    typeof plannedSeconds === 'number' && plannedSeconds > 0
      ? Math.round(plannedSeconds)
      : DEFAULT_FOCUS_SECONDS;
  // 事件在「幾秒前」發生的:即時回報就是 0,離線補送就是積壓的秒數
  const age = typeof ageSeconds === 'number' && ageSeconds >= 0 ? Math.round(ageSeconds) : 0;
  const eventAt = isoSecondsAgo(age);
  const taskText = typeof task === 'string' && task.trim() !== '' ? task.trim() : null;

  const existing = getSessionByUid(db, sessionUid);

  // ── 情況 1:開始事件 ──
  if (type === 'started') {
    if (existing) {
      // 重送的開始事件 → 什麼都不做,直接回原本那筆(idempotent)
      res.json({ session: existing, deduplicated: true });
      return;
    }
    const session = insertRunning(db, {
      source: 'device',
      kind: sessionKind,
      planned_seconds: planned,
      task: taskText,
      session_uid: sessionUid,
      device_id: typeof deviceId === 'string' ? deviceId : null,
      started_at: eventAt,
    });
    log(`實體裝置開始蕃茄鐘 #${session.id} (uid=${sessionUid})`);
    res.status(201).json({ session, deduplicated: false });
    return;
  }

  // ── 情況 2 與 3:結束事件(走完 or 中斷)──
  const status = type === 'completed' ? 'completed' : 'aborted';
  // 走完的話,實際秒數預設就等於預定秒數;中斷則一定要裝置告訴我們跑了多久
  const elapsed =
    typeof elapsedSeconds === 'number' && elapsedSeconds >= 0
      ? Math.round(elapsedSeconds)
      : status === 'completed'
        ? planned
        : 0;

  if (existing) {
    // 情況 2:開始事件收到過 → 更新那一筆。
    //
    // 但這裡要防一種「自我矛盾的紀錄」:started_at 是我們收到開始事件時蓋的,
    // elapsed_seconds 則是裝置用自己的計時器量的。兩者normally會吻合,可是只要
    // 開始事件在路上卡了很久(裝置離線後才補送),就會出現
    // 「started_at 到 ended_at 只差幾秒,但 actual_seconds 寫 1500 秒」這種紀錄。
    //
    // 遇到這種情況我們相信裝置的 elapsed —— 它是單調計時器量的,最可靠 ——
    // 反推回去修正 started_at,紀錄才不會前後打架、時間軸圖表也才畫得對。
    const spanSeconds =
      (new Date(eventAt).getTime() - new Date(existing.started_at).getTime()) / 1000;
    const inconsistent = Math.abs(spanSeconds - elapsed) > 60;
    if (inconsistent) {
      log(
        `uid=${sessionUid} 的時間軸不一致(區間 ${Math.round(spanSeconds)}s vs 實測 ${elapsed}s),` +
          `以實測值回推開始時間`
      );
    }

    const session = finishSession(db, existing.id, {
      status,
      actual_seconds: elapsed,
      ended_at: eventAt,
      started_at: inconsistent ? isoSecondsAgo(age + elapsed) : undefined,
    });
    if (!session) {
      // finishSession 回 null 表示它已經不是 running 了 → 這是重複的結束事件。
      // 回 200 而不是 4xx 很重要:裝置收到 200 才會把佇列裡那筆刪掉,
      // 否則它會永遠重送同一個事件。
      res.json({ session: existing, deduplicated: true });
      return;
    }
    log(`實體裝置蕃茄鐘 #${session.id} ${status}(實際 ${elapsed}s)`);
    res.json({ session, deduplicated: false });
    return;
  }

  // 情況 3:沒有對應的開始事件(裝置當時離線)→ 用 elapsed 回推開始時間,補一整筆
  const created = insertRunning(db, {
    source: 'device',
    kind: sessionKind,
    planned_seconds: planned,
    task: taskText,
    session_uid: sessionUid,
    device_id: typeof deviceId === 'string' ? deviceId : null,
    started_at: isoSecondsAgo(age + elapsed),
  });
  const session = finishSession(db, created.id, {
    status,
    actual_seconds: elapsed,
    ended_at: eventAt,
  });
  log(`補記實體蕃茄鐘 #${created.id} ${status}(離線補送,回推 ${age + elapsed}s)`);
  res.status(201).json({ session, backfilled: true });
});

/**
 * 裝置開機時可以先打這支,確認 token 對不對、順便對時。
 * (回傳伺服器時間,裝置想自己顯示時鐘的話用得到)
 */
app.get('/api/device/hello', requireDeviceToken, (_req, res) => {
  res.json({ ok: true, server_time: nowIso() });
});

// ── 啟動 ────────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`蕃茄鐘後端已啟動:http://localhost:${PORT}`);
  log(`資料庫:${DB_FILE}`);
  if (!DEVICE_TOKEN) {
    log('⚠️ 尚未設定 POMODORO_DEVICE_TOKEN,實體裝置的 API 會回 500。請在 .env 補上。');
  }
});
