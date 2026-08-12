/**
 * ============================================================
 *  蕃茄鐘 MCP Server —— 讓 Claude 讀寫你的專注紀錄
 * ============================================================
 *
 *  架構跟 index.ts(採購)是同一套思路:
 *    MCP server 不做業務邏輯、也不直接開資料庫,
 *    只把常駐後端 (pomodoro/server.ts) 的能力包成 AI 可呼叫的工具。
 *
 *    Claude ──(MCP / stdio)──▶ 本 server ──(HTTP)──▶ pomodoro/server.ts ──▶ SQLite
 *
 *  ❓ 為什麼不讓 MCP server 直接讀 SQLite?
 *     可以,但那會讓「業務規則」散在兩個地方(例如怎麼算 elapsed、
 *     怎麼切日界線)。統一走 REST,實體裝置和 AI 看到的就是同一套規則。
 * ============================================================
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// quiet: true —— 同 index.ts,stdout 是 MCP 協定專用的,不能被污染
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL =
  process.env.POMODORO_API_URL ?? `http://localhost:${process.env.POMODORO_PORT ?? 3101}`;

function log(...args: unknown[]) {
  console.error('[pomodoro-mcp]', ...args);
}

// ── 型別(對應 pomodoro/db.ts 的 Session)────────────────────
interface Session {
  id: number;
  session_uid: string | null;
  source: 'software' | 'device';
  device_id: string | null;
  task: string | null;
  kind: 'focus' | 'break';
  planned_seconds: number;
  actual_seconds: number | null;
  status: 'running' | 'completed' | 'aborted';
  started_at: string;
  ended_at: string | null;
  reported_at: string | null;
}

interface Stats {
  completed_focus_count: number;
  completed_focus_seconds: number;
  aborted_count: number;
  running_count: number;
  by_source: Record<string, number>;
  by_task: { task: string; count: number; seconds: number }[];
}

// ── 呼叫後端的共用小工具 ─────────────────────────────────────
// 蕃茄鐘後端不需要登入(它只在你自己的機器上跑),所以比 index.ts 的
// apiFetch 單純很多 —— 沒有 token、沒有 401 重試。
async function api<T>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    // 後端的錯誤訊息是中文的,盡量原樣帶給使用者,比 HTTP 狀態碼有用
    let detail = `HTTP ${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // 回應不是 JSON 就算了,用上面的狀態碼
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

// ── 顯示用的格式化函式 ───────────────────────────────────────
function formatDuration(seconds: number | null): string {
  if (seconds == null) return 'N/A';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m} 分` : `${m} 分 ${s} 秒`;
}

/** 把 UTC 的 ISO 字串轉成當地時間的 "MM/DD HH:mm" */
function formatLocalTime(iso: string | null): string {
  if (!iso) return 'N/A';
  const offsetHours = Number(process.env.POMODORO_UTC_OFFSET_HOURS ?? 8);
  const d = new Date(new Date(iso).getTime() + offsetHours * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const SOURCE_LABELS: Record<string, string> = {
  software: '軟體',
  device: '實體裝置',
};

const STATUS_LABELS: Record<string, string> = {
  running: '進行中',
  completed: '已完成',
  aborted: '中斷',
};

function formatSessionLine(s: Session, index: number): string {
  const icon = s.status === 'completed' ? '✅' : s.status === 'running' ? '⏳' : '⛔';
  const kindLabel = s.kind === 'focus' ? '專注' : '休息';
  const duration =
    s.status === 'running'
      ? `預定 ${formatDuration(s.planned_seconds)}`
      : formatDuration(s.actual_seconds);
  // 離線補送的紀錄值得標出來,不然使用者會困惑「為什麼這筆現在才出現」
  const late =
    s.ended_at && s.reported_at && new Date(s.reported_at).getTime() - new Date(s.ended_at).getTime() > 60_000
      ? '（離線補送）'
      : '';
  return (
    `${index + 1}. ${icon} #${s.id} ${formatLocalTime(s.started_at)} ${kindLabel} ${duration}${late}\n` +
    `   來源:${SOURCE_LABELS[s.source] ?? s.source}｜狀態:${STATUS_LABELS[s.status] ?? s.status}｜` +
    `任務:${s.task ?? '(未指定)'}`
  );
}

// ── 建立 MCP server ─────────────────────────────────────────
const server = new McpServer({
  name: 'pomodoro-mcp-server',
  version: '1.0.0',
});

// ── 工具 1:檢查蕃茄鐘後端 ───────────────────────────────────
server.registerTool(
  'check_pomodoro_backend',
  {
    title: '檢查蕃茄鐘後端狀態',
    description:
      '檢查蕃茄鐘常駐後端是否正常運作,並回報實體裝置的認證密鑰是否已設定。' +
      '當使用者懷疑實體蕃茄鐘沒有把紀錄傳上來、或要開始使用前想確認連線時使用。',
    inputSchema: {},
  },
  async () => {
    try {
      const data = await api<{
        status: string;
        timestamp: string;
        device_token_configured: boolean;
        db_file: string;
      }>('/api/health');
      const tokenNote = data.device_token_configured
        ? '✅ 已設定(實體裝置可以回報)'
        : '⚠️ 未設定 POMODORO_DEVICE_TOKEN,實體裝置的回報會被拒絕';
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `✅ 蕃茄鐘後端正常運作。\n` +
              `時間:${data.timestamp}\n` +
              `裝置密鑰:${tokenNote}\n` +
              `資料庫:${data.db_file}\n` +
              `(來源:${API_URL}/api/health)`,
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text:
              `❌ 無法連線到蕃茄鐘後端 (${API_URL})。\n錯誤:${message}\n` +
              `請確認已執行 npm run pomodoro:api(預設 port 3101)。`,
          },
        ],
      };
    }
  }
);

// ── 工具 2:開始一顆軟體蕃茄鐘 ───────────────────────────────
server.registerTool(
  'start_pomodoro',
  {
    title: '開始一個蕃茄鐘',
    description:
      '開始一個新的軟體蕃茄鐘(預設 25 分鐘專注)。回傳的編號可用於之後結束它。' +
      '當使用者說「開始一個蕃茄鐘」、「我要專心做 X」時使用。',
    inputSchema: {
      task: z
        .string()
        .optional()
        .describe('可選:這顆蕃茄鐘要做的任務,例如「寫採購報表」。用於之後的統計分組'),
      minutes: z
        .number()
        .positive()
        .default(25)
        .describe('可選:專注幾分鐘,預設 25'),
      kind: z
        .enum(['focus', 'break'])
        .default('focus')
        .describe("可選:'focus' 專注(預設)或 'break' 休息"),
    },
  },
  async ({ task, minutes, kind }) => {
    try {
      const { session } = await api<{ session: Session }>('/api/pomodoro/sessions', {
        method: 'POST',
        body: JSON.stringify({ task, minutes, kind }),
      });
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `⏳ 已開始蕃茄鐘 #${session.id}(${formatDuration(session.planned_seconds)})\n` +
              `任務:${session.task ?? '(未指定)'}\n` +
              `開始時間:${formatLocalTime(session.started_at)}\n\n` +
              `結束時請用 finish_pomodoro 並帶上編號 ${session.id}。`,
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `❌ 開始蕃茄鐘失敗:${message}` }],
      };
    }
  }
);

// ── 工具 3:結束一顆蕃茄鐘 ───────────────────────────────────
server.registerTool(
  'finish_pomodoro',
  {
    title: '結束一個蕃茄鐘',
    description:
      '結束一個進行中的蕃茄鐘,可標記為完成或中斷。' +
      '實際專注秒數由後端依開始時間計算,不需要使用者提供。' +
      '當使用者說「我做完了」、「這顆蕃茄鐘中斷了」時使用。',
    inputSchema: {
      id: z.number().int().positive().describe('要結束的蕃茄鐘編號'),
      aborted: z
        .boolean()
        .default(false)
        .describe('可選:true 表示中途放棄(不計入完成數),預設 false'),
    },
  },
  async ({ id, aborted }) => {
    try {
      const { session } = await api<{ session: Session }>(
        `/api/pomodoro/sessions/${id}/finish`,
        {
          method: 'POST',
          body: JSON.stringify({ status: aborted ? 'aborted' : 'completed' }),
        }
      );
      const verb = session.status === 'completed' ? '✅ 已完成' : '⛔ 已標記中斷';
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${verb}蕃茄鐘 #${session.id}\n` +
              `實際專注:${formatDuration(session.actual_seconds)}(預定 ${formatDuration(session.planned_seconds)})\n` +
              `任務:${session.task ?? '(未指定)'}`,
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `❌ 結束蕃茄鐘失敗:${message}` }],
      };
    }
  }
);

// ── 工具 4:查詢紀錄 ────────────────────────────────────────
// 這支就是需求 (4) 的成果:實體裝置走完的蕃茄鐘,會跟軟體開的並列在這裡,
// 只是 source 欄位標成「實體裝置」。
server.registerTool(
  'list_pomodoro_sessions',
  {
    title: '查詢蕃茄鐘紀錄',
    description:
      '列出蕃茄鐘紀錄,包含軟體開的和實體裝置回報的。可依時間範圍與來源篩選。' +
      '當使用者問「我今天做了哪些蕃茄鐘」、「實體計時器的紀錄有進來嗎」時使用。',
    inputSchema: {
      period: z
        .enum(['today', 'yesterday', 'week', 'all'])
        .default('today')
        .describe("時間範圍:'today'(預設)、'yesterday'、'week'(近 7 天)、'all'"),
      source: z
        .enum(['software', 'device'])
        .optional()
        .describe("可選:只看某個來源。'device' = 實體蕃茄鐘,'software' = 軟體"),
      limit: z.number().int().positive().default(20).describe('可選:最多回傳幾筆,預設 20'),
    },
  },
  async ({ period, source, limit }) => {
    try {
      // 時間範圍的換算(當地時區的日界線)交給後端做,MCP 端不重複實作
      const { from, to, period: label } = await api<{
        period: string;
        from: string;
        to: string;
      }>(`/api/pomodoro/stats?period=${period}`);

      const query = new URLSearchParams({ from, to, limit: String(limit) });
      if (source) query.set('source', source);
      const { sessions } = await api<{ sessions: Session[] }>(
        `/api/pomodoro/sessions?${query.toString()}`
      );

      if (sessions.length === 0) {
        const sourceNote = source ? `(來源:${SOURCE_LABELS[source]})` : '';
        return {
          content: [{ type: 'text' as const, text: `${label}沒有任何蕃茄鐘紀錄${sourceNote}。` }],
        };
      }

      const lines = sessions.map(formatSessionLine);
      return {
        content: [
          {
            type: 'text' as const,
            text: `${label}共 ${sessions.length} 筆紀錄:\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `❌ 查詢蕃茄鐘紀錄失敗:${message}` }],
      };
    }
  }
);

// ── 工具 5:專注統計 ────────────────────────────────────────
server.registerTool(
  'get_focus_stats',
  {
    title: '取得專注統計',
    description:
      '統計某段時間內完成的專注蕃茄鐘數量、總時數、中斷次數,並依任務與來源分組。' +
      '當使用者問「我今天專注了多久」、「這週做了幾顆蕃茄」時使用。',
    inputSchema: {
      period: z
        .enum(['today', 'yesterday', 'week', 'all'])
        .default('today')
        .describe("時間範圍:'today'(預設)、'yesterday'、'week'(近 7 天)、'all'"),
    },
  },
  async ({ period }) => {
    try {
      const data = await api<{ period: string; stats: Stats }>(
        `/api/pomodoro/stats?period=${period}`
      );
      const s = data.stats;

      const sourceLines = Object.entries(s.by_source).map(
        ([src, count]) => `  ${SOURCE_LABELS[src] ?? src}:${count} 顆`
      );
      const taskLines = s.by_task
        .slice(0, 10)
        .map((t) => `  ${t.task}:${t.count} 顆 / ${formatDuration(t.seconds)}`);

      const parts = [
        `📊 ${data.period}的專注統計`,
        ``,
        `完成的專注蕃茄鐘:${s.completed_focus_count} 顆`,
        `總專注時間:${formatDuration(s.completed_focus_seconds)}`,
        `中斷次數:${s.aborted_count}`,
        `進行中:${s.running_count}`,
      ];
      if (sourceLines.length > 0) parts.push(``, `依來源:`, ...sourceLines);
      if (taskLines.length > 0) parts.push(``, `依任務:`, ...taskLines);

      return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `❌ 取得專注統計失敗:${message}` }],
      };
    }
  }
);

// ── 啟動 ────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`蕃茄鐘 MCP server 已啟動,後端指向 ${API_URL}`);
}

main().catch((err) => {
  log('啟動失敗:', err);
  process.exit(1);
});
