/**
 * ============================================================
 *  採購流程 MCP Server —— 第一階段 · 第二步
 * ============================================================
 *
 *  新增了兩件事(相較第一步):
 *    (1) 登入機制:server 會用 .env 的帳密去 POST /api/auth/login
 *        換取 JWT token,快取起來,呼叫需認證的 API 時自動帶上。
 *        token 過期(收到 401)時會自動重新登入再試一次。
 *    (2) 第一個「真正的」採購查詢工具 search_purchase_orders,
 *        示範怎麼用 zod 定義工具參數。
 *
 *  管線一樣是:
 *    AI client ──(MCP)──▶ 這支 server ──(HTTP + Bearer token)──▶ 你的後端
 * ============================================================
 */

// ── 0. 載入 .env(一定要放在最前面,才能讓後面讀得到)──────────
// dotenv 會把 .env 檔的內容塞進 process.env,程式才讀得到 BACKEND_EMAIL 等。
// ⚠️ 為什麼要指定絕對路徑?
//   dotenv 預設是從「目前工作目錄 cwd」找 .env,但 Claude Desktop
//   啟動這支 server 時 cwd 不一定是專案資料夾,可能就找不到 .env。
//   所以我們用 index.ts 自己的所在目錄去組出 .env 的絕對路徑,最保險。
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// quiet: true 很關鍵!dotenv v17 預設會印一行 "injected env..." 到 stdout,
// 但 stdio 模式下 stdout 是 MCP 協定專用的,那行會污染協定、讓連線壞掉。
// 所以一定要關掉它。(這正是「stdout 不能亂印」鐵則的實例)
dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ── 設定 ────────────────────────────────────────────────────
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';
// 登入用帳密(放在 .env,不要寫死在程式裡)
const BACKEND_EMAIL = process.env.BACKEND_EMAIL ?? '';
const BACKEND_PASSWORD = process.env.BACKEND_PASSWORD ?? '';

function log(...args: unknown[]) {
  console.error('[procurement-mcp]', ...args);
}

// ── 認證:token 快取 + 自動登入 ──────────────────────────────
// 用一個模組層級變數把拿到的 token 記住,避免每次呼叫都重新登入。
let cachedToken: string | null = null;

/**
 * 登入後端,拿到 JWT token 並快取起來。
 * 對應後端:POST /api/auth/login  body: { email, password }
 *          回傳:{ token, user: {...} }
 */
async function login(): Promise<string> {
  if (!BACKEND_EMAIL || !BACKEND_PASSWORD) {
    throw new Error('尚未設定 BACKEND_EMAIL / BACKEND_PASSWORD(請檢查 .env)');
  }

  const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: BACKEND_EMAIL, password: BACKEND_PASSWORD }),
  });

  if (!res.ok) {
    throw new Error(`登入失敗:HTTP ${res.status}(請確認 .env 的帳密正確)`);
  }

  const data = (await res.json()) as { token?: string };
  if (!data.token) {
    throw new Error('登入回應沒有 token,格式不如預期');
  }

  cachedToken = data.token;
  log('登入成功,已取得 token');
  return data.token;
}

/**
 * 呼叫「需認證」API 的共用小工具。
 *  - 沒有 token 就先登入
 *  - 自動帶上 Authorization: Bearer <token>
 *  - 如果收到 401(token 過期/無效),自動重新登入再試「一次」
 *
 * 這個 helper 是重點:之後每個需認證的工具都靠它,
 * 不用各自處理登入邏輯。
 */
async function apiFetch(path: string): Promise<Response> {
  // 確保手上有 token(第一次會觸發登入)
  if (!cachedToken) {
    await login();
  }

  // 內部小函式:帶著目前 token 發請求
  const doRequest = () =>
    fetch(`${BACKEND_URL}${path}`, {
      headers: { Authorization: `Bearer ${cachedToken}` },
    });

  let res = await doRequest();

  // token 可能過期了 → 清掉、重新登入、再試一次
  if (res.status === 401) {
    log('token 失效,重新登入中…');
    cachedToken = null;
    await login();
    res = await doRequest();
  }

  return res;
}

// ── 採購單狀態碼對照表 ───────────────────────────────────────
// 後端存的 status 是 Freshservice 的「數字狀態碼」(例如 15、20、25),
// 直接顯示數字沒有意義,所以用這張表翻成人看得懂的文字。
//
// ⚠️ 以下文字是 Freshservice 常見的對應,但「每個公司/實例可能不同」。
//    請對照你的 FreshService 實際畫面確認,若不對就改這裡的文字即可。
//    (我們在顯示時會「同時保留原始數字」,所以就算文字標錯也不會誤導)
const PO_STATUS_LABELS: Record<number, string> = {
  5: '開立',    // Open
  10: '待審核', // Pending Approval
  15: '已下單', // Ordered
  20: '部分收貨', // Partially Received
  25: '已收貨', // Received
  30: '已取消', // Cancelled
};

// 把數字狀態碼格式化成好讀的文字;未知的碼也安全處理(顯示原碼)。
function formatStatus(code: number | null): string {
  if (code == null) return 'N/A';
  const label = PO_STATUS_LABELS[code];
  return label ? `${label}(${code})` : `狀態碼 ${code}(未對應)`;
}

// ── 建立 MCP server ─────────────────────────────────────────
const server = new McpServer({
  name: 'procurement-mcp-server',
  version: '1.0.0',
});

// ── 工具 1:check_backend_health(公開端點,不需登入)─────────
server.registerTool(
  'check_backend_health',
  {
    title: '檢查採購後端健康狀態',
    description:
      '檢查採購流程後端服務是否正常運作。會呼叫後端的 /api/health 端點。' +
      '當使用者想確認系統是否上線,或在做其他操作前想先確認連線時使用。',
    inputSchema: {},
  },
  async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/health`);
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `後端回應異常:HTTP ${res.status} ${res.statusText}` }],
        };
      }
      const data = (await res.json()) as { status?: string; timestamp?: string };
      return {
        content: [
          {
            type: 'text' as const,
            text: `✅ 後端正常運作。\n狀態:${data.status}\n時間:${data.timestamp}\n(來源:${BACKEND_URL}/api/health)`,
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
            text: `❌ 無法連線到後端 (${BACKEND_URL})。\n錯誤:${message}\n請確認採購後端已啟動(預設 port 3001)。`,
          },
        ],
      };
    }
  }
);

// ── 工具 2:search_purchase_orders(需登入)——進階版 ─────────
// 這裡的重點是 inputSchema:用 zod 描述工具「接受什麼參數」。
// 這次示範三種 zod 用法:
//   q      → 必填字串(.min(1))
//   status → 選填 enum(.optional(),只能是特定幾個值之一)
//   limit  → 有預設值的數字(.default(),不給就用 20)
//
// ⚠️ 重要觀念:你的後端搜尋 route 其實「只吃 q」這一個參數。
//   所以 status 篩選 和 limit 筆數限制,是這支「MCP 工具自己」
//   在拿到後端結果後做的「後處理」——這就是 MCP 工具可以在
//   既有後端之上「加值」的地方。註解裡我會標清楚哪段是後處理。
server.registerTool(
  'search_purchase_orders',
  {
    title: '搜尋採購單',
    description:
      '依關鍵字搜尋採購單(會比對採購單號 po_number 或名稱 name),' +
      '可選擇性地只篩選特定狀態、並限制回傳筆數。' +
      '當使用者想查詢、尋找採購單時使用,例如「幫我找已核准的螢幕採購單,最多 5 筆」。',
    inputSchema: {
      // 必填:沒加 .optional(),AI 一定要提供
      q: z
        .string()
        .min(1)
        .describe('搜尋關鍵字,可以是採購單號或採購單名稱的一部分'),
      // 選填數字狀態碼:後端的 status 是數字,所以這裡也用數字比對。
      // (常見:15=已下單、20=部分收貨、25=已收貨;完整見 PO_STATUS_LABELS)
      status: z
        .number()
        .int()
        .optional()
        .describe('可選:只篩選特定狀態碼的採購單,例如 15(已下單)、25(已收貨)'),
      // 有預設值:AI 不給時自動變成 20,所以 handler 裡拿到的一定是數字
      limit: z
        .number()
        .int()
        .positive()
        .default(20)
        .describe('可選:最多回傳幾筆,預設 20'),
    },
  },
  // handler 收到「已驗證 + 已套用預設值」的參數。
  // 注意:因為 limit 有 .default(20),這裡拿到的 limit 必定是數字(不會是 undefined)。
  async ({ q, status, limit }) => {
    try {
      // ── (A) 呼叫後端:後端只認得 q ──
      const res = await apiFetch(`/api/purchase-orders/search?q=${encodeURIComponent(q)}`);

      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `搜尋失敗:HTTP ${res.status} ${res.statusText}` }],
        };
      }

      const data = (await res.json()) as { purchase_orders?: PurchaseOrder[] };
      let list = data.purchase_orders ?? [];

      // ── (B) 工具端後處理:這些是後端沒做、由 MCP 工具補上的 ──
      // (B-1) 若指定了 status,只留下該狀態的採購單(數字比對數字)
      if (status != null) {
        list = list.filter((po) => po.status === status);
      }
      // (B-2) 限制筆數
      const total = list.length;
      list = list.slice(0, limit);

      if (list.length === 0) {
        const cond = status != null ? `符合「${q}」且狀態為 ${formatStatus(status)}` : `符合「${q}」`;
        return {
          content: [{ type: 'text' as const, text: `找不到${cond}的採購單。` }],
        };
      }

      const lines = list.map((po, i) => {
        return (
          `${i + 1}. ${po.po_number ?? '(無單號)'} — ${po.name ?? '(無名稱)'}\n` +
          `   狀態:${formatStatus(po.status)}｜金額:${po.total_cost ?? 'N/A'}｜` +
          `預計交期:${po.expected_delivery_date ?? 'N/A'}`
        );
      });

      // 若因為 limit 而截斷,提示一下總數
      const header =
        total > list.length
          ? `找到 ${total} 筆,顯示前 ${list.length} 筆:`
          : `找到 ${list.length} 筆採購單:`;

      return {
        content: [{ type: 'text' as const, text: `${header}\n\n${lines.join('\n')}` }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `❌ 搜尋採購單時發生錯誤:${message}` }],
      };
    }
  }
);

// 採購單的型別(對應後端 search route 回傳的欄位)
interface PurchaseOrder {
  id: number | string;
  po_number: string | null;
  name: string | null;
  vendor_id: string | null;
  total_cost: number | null;
  status: number | null; // Freshservice 的數字狀態碼(見 PO_STATUS_LABELS)
  expected_delivery_date: string | null;
  created_at: string | null;
}

// ── 啟動 ────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server 已啟動,後端指向 ${BACKEND_URL}`);
}

main().catch((err) => {
  log('啟動失敗:', err);
  process.exit(1);
});
