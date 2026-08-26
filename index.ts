/**
 * ============================================================
 *  採購流程 MCP Server —— 第一階段 · 第四步
 * ============================================================
 *
 *  新增了兩件事(相較第一步):
 *    (1) 登入機制:server 會用 .env 的帳密去 POST /api/auth/login
 *        換取 JWT token,快取起來,呼叫需認證的 API 時自動帶上。
 *        token 過期(收到 401)時會自動重新登入再試一次。
 *    (2) 第一個「真正的」採購查詢工具 search_purchase_orders,
 *        示範怎麼用 zod 定義工具參數。
 *
 *  ── 第三步新增 ──────────────────────────────────────────────
 *    (3) get_purchase_order_details:查單一採購單的明細。
 *        示範「一個 MCP 工具串接多個後端呼叫」——後端的明細 API 只認
 *        數字 id,所以先用搜尋把採購單號換成 id,再去拿明細;
 *        對 AI 來說仍然只是呼叫一個工具。
 *
 *  ── 第四步新增 ──────────────────────────────────────────────
 *    (4) check_esign_status:查電子簽核進度。
 *        這個工具的重點是「誠實處理資料的限制」——後端的
 *        esign_requests 表沒有任何採購單欄位,所以「這張單簽到哪了」
 *        只能用主旨文字比對,工具必須把這件事講出來,
 *        不能讓 AI 以為那是可靠的關聯。
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
// ⚠️ 但「自己的所在目錄」會隨「怎麼執行」而改變:
//   用 tsx 直跑 index.ts 時,__dirname 就是專案根目錄 → .env 在旁邊;
//   npm run build 編譯後跑 dist/index.js 時,__dirname 變成 dist/ →
//   .env 其實在上一層。只寫死一個位置,編譯版就永遠讀不到帳密、
//   登入必定失敗。所以兩個位置都找,先找到的那個就用。
import dotenv from 'dotenv';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = [
  path.join(__dirname, '.env'),       // tsx 直跑:專案根目錄
  path.join(__dirname, '..', '.env'), // 編譯後跑 dist/:上一層
].find((candidate) => fs.existsSync(candidate));

// quiet: true 很關鍵!dotenv v17 預設會印一行 "injected env..." 到 stdout,
// 但 stdio 模式下 stdout 是 MCP 協定專用的,那行會污染協定、讓連線壞掉。
// 所以一定要關掉它。(這正是「stdout 不能亂印」鐵則的實例)
if (envPath) {
  dotenv.config({ path: envPath, quiet: true });
} else {
  // 同理,這行警告也只能走 stderr。找不到 .env 不直接中斷,
  // 因為使用者也可能是用系統環境變數餵設定進來的。
  console.error('[procurement-mcp] 警告:找不到 .env,改用系統環境變數');
}

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

// ── 簽署人狀態對照表 ─────────────────────────────────────────
// 這些是 DropboxSign 回傳的 statusCode。跟採購單狀態一樣,
// 顯示時同時保留原始代碼,標錯也不會誤導。
//
// ⚠️ 'unknown' 有特別意義:後端呼叫 DropboxSign 失敗時,會退回本地
//    資料庫存的簽署人名單,並把狀態填成 unknown。也就是說 unknown
//    代表「問不到即時狀態」,不是「這個人還沒簽」——差別很大。
const SIGNER_STATUS_LABELS: Record<string, string> = {
  signed: '已簽署',
  awaiting_signature: '等待簽署',
  declined: '已拒簽',
  on_hold: '暫停中',
  unknown: '問不到即時狀態',
};

function formatSignerStatus(code: string): string {
  const label = SIGNER_STATUS_LABELS[code];
  return label ? `${label}(${code})` : `${code}(未對應)`;
}

// ── 共用:呼叫後端的採購單搜尋 ────────────────────────────────
// 後端:GET /api/purchase-orders/search?q=<keyword>
//      回傳:{ purchase_orders: [...] }
// 兩個工具都要用到它(search_purchase_orders 直接列結果;
// get_purchase_order_details 用它把「單號」換成後端的數字 id),
// 所以抽成一個函式,不要各自寫一份 fetch。
async function searchPurchaseOrders(q: string): Promise<PurchaseOrder[]> {
  const res = await apiFetch(`/api/purchase-orders/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) {
    throw new Error(`後端搜尋失敗:HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { purchase_orders?: PurchaseOrder[] };
  return data.purchase_orders ?? [];
}

// ── 共用:把使用者說的「採購單」換成後端要的數字 id ───────────
// ⚠️ 後端 GET /api/purchase-orders/:id/details 的 :id 是「後端資料庫的
//    數字 id」,不是採購單號 po_number。但使用者和 AI 手上通常只有單號
//    (「幫我看 PO-0001 的明細」),所以這裡先用搜尋把單號換成 id。
//    這是 MCP 工具很典型的加值:把後端的內部識別碼藏起來,
//    讓 AI 用人類的說法就查得到。
type ResolveResult =
  | { ok: true; id: number; header: PurchaseOrder | null }
  | { ok: false; message: string };

async function resolvePurchaseOrder(po: string): Promise<ResolveResult> {
  const trimmed = po.trim();

  // 純數字 → 當成後端 id 直接用。
  // (這條路我們手上沒有表頭資料,所以輸出會少「單號 — 名稱」那一行)
  if (/^\d+$/.test(trimmed)) {
    return { ok: true, id: Number(trimmed), header: null };
  }

  const candidates = await searchPurchaseOrders(trimmed);

  // 先找「單號完全相同」的那一筆(不分大小寫)
  const exact = candidates.filter(
    (c) => c.po_number?.toLowerCase() === trimmed.toLowerCase()
  );
  if (exact.length === 1) {
    return { ok: true, id: Number(exact[0].id), header: exact[0] };
  }

  if (candidates.length === 0) {
    return { ok: false, message: `找不到單號或名稱符合「${trimmed}」的採購單。` };
  }

  // 有相近的但沒有完全相同的 → 列出選項讓使用者指定。
  // ⚠️ 這裡刻意不自己猜第一筆:猜錯會把別張單的明細講得像這張單的,
  //    這種錯比「查不到」嚴重得多。
  const options = candidates
    .slice(0, 10)
    .map((c) => `  - ${c.po_number ?? '(無單號)'} — ${c.name ?? '(無名稱)'}`)
    .join('\n');
  return {
    ok: false,
    message:
      `「${trimmed}」不是完整的採購單號。找到 ${candidates.length} 筆相近的資料,` +
      `請指定其中一個單號:\n${options}`,
  };
}

// ── 共用:抓簽核請求 ─────────────────────────────────────────
// 後端:GET /api/esign/requests?page=&pageSize=  (pageSize 上限 50)
//      回傳:{ data, page, pageSize, total, totalPages }
// 後端會自己清掉舊的已完成請求(只留最近 10 筆),所以總量通常很小,
// 這裡最多翻 MAX_ESIGN_PAGES 頁就停,並回報有沒有被截斷——
// 截斷了就要說,不能讓「沒找到」看起來像「不存在」。
const MAX_ESIGN_PAGES = 5;

async function fetchESignRequests(): Promise<{
  requests: ESignRequest[];
  total: number;
  truncated: boolean;
}> {
  const requests: ESignRequest[] = [];
  let page = 1;
  let totalPages = 1;
  let total = 0;

  while (page <= totalPages && page <= MAX_ESIGN_PAGES) {
    const res = await apiFetch(`/api/esign/requests?page=${page}&pageSize=50`);
    if (!res.ok) {
      throw new Error(`取得簽核請求失敗:HTTP ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as ESignRequestsPage;
    requests.push(...(body.data ?? []));
    totalPages = body.totalPages ?? 1;
    total = body.total ?? requests.length;
    page += 1;
  }

  return { requests, total, truncated: totalPages > MAX_ESIGN_PAGES };
}

// ── 共用:用文字比對找「可能屬於某張採購單」的簽核請求 ──────────
// ⚠️ 這是整個工具最需要誠實的地方。
//   後端沒有 PO ↔ 簽核 的關聯欄位(見 ESignRequest 的註解),簽核是從
//   「付款申請」發起的,而 esign/send 收到的 invoiceIds 也沒有存進 DB。
//   所以這裡只能看「主旨或廠商欄位裡有沒有出現採購單號 / 它的發票號」。
//   這是猜測,不是關聯:
//     - 比對到 → 只能說「可能相關」
//     - 比對不到 → 不能說「這張單沒送簽」,只能說「比對不到」
//   工具的輸出必須把這個界線講清楚,否則 AI 會把猜測講成事實。
function findRelatedESignRequests(
  requests: ESignRequest[],
  needles: string[]
): { request: ESignRequest; matchedOn: string }[] {
  const cleaned = needles
    .map((n) => n?.trim().toLowerCase())
    .filter((n): n is string => !!n && n.length >= 3); // 太短的字串會亂中

  const hits: { request: ESignRequest; matchedOn: string }[] = [];
  for (const req of requests) {
    const haystack = `${req.subject ?? ''} ${req.vendor ?? ''}`.toLowerCase();
    const matched = cleaned.find((n) => haystack.includes(n));
    if (matched) hits.push({ request: req, matchedOn: matched });
  }
  return hits;
}

// 把一筆簽核請求排版成好讀的文字
function formatESignRequest(req: ESignRequest, index: number): string {
  const overall = req.isComplete ? '✅ 已完成' : '進行中';
  const head =
    `${index + 1}. ${req.subject ?? '(無主旨)'}\n` +
    `   廠商:${req.vendor ?? 'N/A'}｜建立時間:${req.createdAt ?? 'N/A'}｜` +
    `整體狀態:${overall}${req.testMode ? '｜⚠️ 測試模式' : ''}`;

  const signers = [...(req.signers ?? [])].sort((a, b) => a.signOrder - b.signOrder);
  if (signers.length === 0) {
    return `${head}\n   (沒有簽署人資料)`;
  }
  const lines = signers.map(
    (sg, i) => `     ${i + 1}. ${sg.name || '(無姓名)'} <${sg.email || '無 email'}> — ` +
      `${formatSignerStatus(sg.statusCode)}`
  );
  return `${head}\n   簽署人:\n${lines.join('\n')}`;
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
      // ── (A) 呼叫後端:後端只認得 q(改用共用的 searchPurchaseOrders)──
      let list = await searchPurchaseOrders(q);

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


// ── 工具 3:get_purchase_order_details(需登入)─────────────────
// 這個工具示範兩件第二步沒有的事:
//   (1) 一個 MCP 工具可以「串接多個後端呼叫」:先用搜尋把採購單號換成
//       後端的數字 id,再去拿明細。對 AI 來說仍然只是呼叫一個工具。
//   (2) 後端回傳的 warning 欄位要照實轉達,不能靜靜吞掉。
//       這是「工具的誠實」問題:見 PurchaseOrderDetails.warning 的註解。
server.registerTool(
  'get_purchase_order_details',
  {
    title: '查詢採購單明細',
    description:
      '查詢單一採購單的完整明細,包含採購品項、送達與付款資訊、已登錄的發票、以及附件。' +
      '直接給採購單號即可(例如 PO-0001)。' +
      '當使用者想知道某一張採購單「買了什麼」、「發票開了沒」、「有哪些附件」時使用。' +
      '若只是想依關鍵字找出「有哪些採購單」,請改用 search_purchase_orders。',
    inputSchema: {
      po: z
        .string()
        .min(1)
        .describe(
          '要查的採購單。通常給採購單號,例如 PO-0001;' +
            '若已知後端的數字 id,也可以直接給數字'
        ),
    },
  },
  async ({ po }) => {
    try {
      // ── (A) 先把使用者說的單號換成後端要的數字 id ──
      const resolved = await resolvePurchaseOrder(po);
      if (!resolved.ok) {
        // 找不到或不夠明確,都不是「錯誤」,而是需要使用者補資訊,
        // 所以不設 isError,讓 AI 能自然地把訊息轉述給人。
        return { content: [{ type: 'text' as const, text: resolved.message }] };
      }

      // ── (B) 拿明細 ──
      const res = await apiFetch(`/api/purchase-orders/${resolved.id}/details`);

      if (res.status === 404) {
        return {
          content: [
            { type: 'text' as const, text: `後端查不到 id 為 ${resolved.id} 的採購單。` },
          ],
        };
      }
      if (!res.ok) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `查詢明細失敗:HTTP ${res.status} ${res.statusText}`,
            },
          ],
        };
      }

      const detail = (await res.json()) as PurchaseOrderDetails;

      // ── (C) 組成人看得懂的輸出。用一段一段拼,最後用空行隔開 ──
      const sections: string[] = [];

      // 表頭:只有「用單號查」時才有(明細 API 本身不含表頭欄位)
      if (resolved.header) {
        const h = resolved.header;
        sections.push(
          `採購單 ${h.po_number ?? '(無單號)'} — ${h.name ?? '(無名稱)'}\n` +
            `狀態:${formatStatus(h.status)}｜金額:${h.total_cost ?? 'N/A'}｜` +
            `預計交期:${h.expected_delivery_date ?? 'N/A'}`
        );
      } else {
        sections.push(`採購單(後端 id ${resolved.id})的明細:`);
      }

      // ⚠️ 後端抓 FreshService 失敗時一定要明講。
      //    否則下面的「品項:無」會被讀成「這張單沒有品項」,那是錯的。
      if (detail.warning) {
        sections.push(
          `⚠️ 後端無法從 FreshService 取得此採購單的品項與基本資料` +
            `(後端訊息:${detail.warning})。\n` +
            `   所以下面的「採購品項」與「基本資料」可能是空的——` +
            `這代表「取不到」,不代表「沒有」。`
        );
      }

      // 採購品項
      const items = detail.purchase_items ?? [];
      if (items.length > 0) {
        const lines = items.map((it, i) => {
          const head =
            `${i + 1}. ${it.item_name ?? '(無品名)'} × ${it.quantity ?? 'N/A'}` +
            `｜單價:${it.unit_price ?? 'N/A'}｜小計:${it.total_cost ?? 'N/A'}`;
          return it.description ? `${head}\n   說明:${it.description}` : head;
        });
        sections.push(`【採購品項】共 ${items.length} 項\n${lines.join('\n')}`);
      } else if (!detail.warning) {
        // 沒有 warning 才敢說「無」——有 warning 時上面已經解釋過了
        sections.push('【採購品項】無');
      }

      // 基本資料:info 的每個欄位都可能是 null,只列出真的有值的
      const info = detail.info ?? {};
      const infoRows: string[] = [];
      if (info.requestor_deliver_to) infoRows.push(`收件人/送達:${info.requestor_deliver_to}`);
      if (info.payment_terms != null && info.payment_terms !== '')
        infoRows.push(`付款條件:${info.payment_terms}`);
      if (info.date_of_order) infoRows.push(`下單日期:${info.date_of_order}`);
      if (info.shipping_address) infoRows.push(`送貨地址:${info.shipping_address}`);
      if (infoRows.length > 0) {
        sections.push(`【基本資料】\n${infoRows.map((r) => `  ${r}`).join('\n')}`);
      }

      // 發票(來自後端本地資料庫,不是 FreshService,所以不受 warning 影響)
      const invoices = detail.invoices ?? [];
      if (invoices.length > 0) {
        const lines = invoices.map(
          (inv, i) =>
            `${i + 1}. ${inv.invoice_number ?? '(無發票號)'}` +
            `｜金額:${inv.total ?? 'N/A'}｜狀態:${inv.status ?? 'N/A'}`
        );
        sections.push(`【發票】共 ${invoices.length} 張\n${lines.join('\n')}`);
      } else {
        sections.push('【發票】尚無登錄的發票');
      }

      // 附件:processed 代表這個檔案已經被解析成某張發票
      const attachments = detail.attachments ?? [];
      if (attachments.length > 0) {
        const lines = attachments.map((a, i) => {
          const state = a.processed
            ? `已對應發票 ${a.invoice_number ?? '(未知號碼)'}`
            : '尚未處理';
          return `${i + 1}. ${a.filename}(${state})`;
        });
        sections.push(`【附件】共 ${attachments.length} 個\n${lines.join('\n')}`);
      } else {
        sections.push('【附件】無');
      }

      return { content: [{ type: 'text' as const, text: sections.join('\n\n') }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `❌ 查詢採購單明細時發生錯誤:${message}` }],
      };
    }
  }
);


// ── 工具 4:check_esign_status(需登入)───────────────────────
// 兩種用法:
//   給 po   → 找「可能屬於這張採購單」的簽核請求(文字比對,見下)
//   不給 po → 列出最近的簽核請求
//
// ⚠️ 這個工具的設計重點是「誠實」。後端沒有 PO ↔ 簽核的關聯欄位,
//   所以給 po 的那條路只能做文字比對。工具在輸出裡一定要把
//   「這是猜的」講清楚,否則 AI 會把「主旨沒寫單號」講成「沒送簽」,
//   在採購流程裡那是會害人做錯決定的答案。
server.registerTool(
  'check_esign_status',
  {
    title: '查詢電子簽核進度',
    description:
      '查詢電子簽核(DropboxSign)的進度,包含每位簽署人簽了沒。' +
      '不給參數時列出最近的簽核請求;給採購單號時,會找出主旨或廠商欄位' +
      '提到該單號(或其發票號)的簽核請求。' +
      '當使用者想知道「簽到哪了」、「誰還沒簽」、「有哪些在跑簽核」時使用。' +
      '注意:後端沒有採購單與簽核請求的關聯欄位,依採購單查詢是文字比對,' +
      '比對不到不代表該採購單沒有送簽。',
    inputSchema: {
      po: z
        .string()
        .optional()
        .describe(
          '可選:採購單號(例如 PO-0001)。給了就只找可能跟這張單相關的簽核;' +
            '不給就列出最近的簽核請求'
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .default(10)
        .describe('可選:列表模式最多顯示幾筆,預設 10'),
    },
  },
  async ({ po, limit }) => {
    try {
      const { requests, total, truncated } = await fetchESignRequests();

      // 翻頁被截斷時要說,否則「沒找到」會被誤讀成「不存在」
      const truncNote = truncated
        ? `\n\n⚠️ 後端的簽核請求超過 ${MAX_ESIGN_PAGES} 頁,以上並非全部。`
        : '';

      // ── 模式 A:沒給採購單 → 列出最近的簽核請求 ──
      if (!po || !po.trim()) {
        if (requests.length === 0) {
          return { content: [{ type: 'text' as const, text: '目前沒有任何簽核請求。' }] };
        }
        const shown = requests.slice(0, limit);
        const header =
          total > shown.length
            ? `目前共 ${total} 筆簽核請求,顯示最近 ${shown.length} 筆:`
            : `目前共 ${shown.length} 筆簽核請求:`;
        const body = shown.map((r, i) => formatESignRequest(r, i)).join('\n\n');
        return {
          content: [{ type: 'text' as const, text: `${header}\n\n${body}${truncNote}` }],
        };
      }

      // ── 模式 B:給了採購單 → 先確認單子存在 ──
      const resolved = await resolvePurchaseOrder(po);
      if (!resolved.ok) {
        return { content: [{ type: 'text' as const, text: resolved.message }] };
      }

      // 收集比對用的關鍵字:採購單號 + 這張單底下的發票號
      const needles: string[] = [];
      if (resolved.header?.po_number) needles.push(resolved.header.po_number);
      try {
        const detailRes = await apiFetch(`/api/purchase-orders/${resolved.id}/details`);
        if (detailRes.ok) {
          const detail = (await detailRes.json()) as PurchaseOrderDetails;
          for (const inv of detail.invoices ?? []) {
            if (inv.invoice_number) needles.push(inv.invoice_number);
          }
        }
      } catch {
        // 拿不到發票號不是致命問題,退回只用單號比對
      }

      const label = resolved.header
        ? `採購單 ${resolved.header.po_number ?? '(無單號)'} — ${resolved.header.name ?? '(無名稱)'}`
        : `採購單(後端 id ${resolved.id})`;

      // 用數字 id 查時我們沒有單號,也就沒有東西可以比對——這要講明白,
      // 不能回一句「找不到」讓人以為是沒送簽。
      if (needles.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `${label}\n\n` +
                `無法比對簽核請求:後端沒有「採購單 ↔ 簽核請求」的關聯欄位,` +
                `只能用採購單號或發票號去比對簽核主旨,` +
                `而這次查詢是用數字 id、手上沒有單號。\n` +
                `請改用採購單號查詢(例如 PO-0001)。`,
            },
          ],
        };
      }

      const caveat =
        `⚠️ 後端沒有「採購單 ↔ 簽核請求」的關聯欄位(esign_requests 只存廠商、` +
        `主旨與簽署人,沒有採購單號)。以下是用「主旨或廠商欄位裡有沒有出現 ` +
        `${needles.join('、')}」比對出來的,只能算「可能相關」。`;

      const hits = findRelatedESignRequests(requests, needles);

      if (hits.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `${label}\n\n${caveat}\n\n` +
                `在目前的 ${requests.length} 筆簽核請求裡,沒有比對到。\n` +
                `⚠️ 這不代表這張採購單沒有送簽——只代表沒有簽核請求的主旨或` +
                `廠商欄位寫到上面那些字。要確認有沒有送簽,請到系統畫面查看。` +
                truncNote,
            },
          ],
        };
      }

      const body = hits
        .map(
          ({ request, matchedOn }, i) =>
            `${formatESignRequest(request, i)}\n   (比對命中:${matchedOn})`
        )
        .join('\n\n');

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${label}\n\n${caveat}\n\n` +
              `比對到 ${hits.length} 筆可能相關的簽核請求:\n\n${body}${truncNote}`,
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `❌ 查詢簽核進度時發生錯誤:${message}` }],
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

// 採購單明細的型別(對應後端 routes/purchaseOrderDetails.ts 的回傳)
// 注意:這支 API「不含表頭欄位」(沒有 po_number / name / status / 金額),
// 只給品項、基本資料、發票、附件。所以工具的表頭是拿搜尋結果補上的。
interface PurchaseOrderDetails {
  purchase_items: {
    item_name: string | null;
    description: string | null;
    quantity: number | null;
    unit_price: number | null;
    total_cost: number | null;
  }[];
  info: {
    requestor_deliver_to?: string | null;
    payment_terms?: string | number | null;
    date_of_order?: string | null;
    shipping_address?: string | null;
  };
  invoices: {
    id: number | string;
    invoice_number: string | null;
    total: number | null;
    status: string | null;
    source_filename: string | null;
  }[];
  attachments: {
    filename: string;
    path: string;
    processed: boolean; // 這個檔案是否已被解析成某張發票
    invoice_number: string | null;
  }[];
  // 後端向 FreshService 取資料失敗時才會出現這個欄位。
  // ⚠️ 很重要:有 warning 的時候 purchase_items 和 info 會是空的,
  //    但那是「抓取失敗」,不是「這張單沒有品項」。工具一定要照實轉達,
  //    否則 AI 會把失敗講成「查無品項」,那是會誤導人的錯誤答案。
  warning?: string;
}

// 簽核請求的型別(對應後端 GET /api/esign/requests 的回傳)
// ⚠️ 注意這裡「沒有」任何採購單欄位:後端的 esign_requests 表只有
//    signature_request_id / vendor / subject / test_mode / created_at
//    / is_complete。所以採購單和簽核請求之間沒有資料層的關聯,
//    只能靠 subject 的文字去猜——見 findRelatedESignRequests()。
interface ESignRequest {
  signatureRequestId: string;
  vendor: string | null;
  subject: string | null;
  testMode: boolean;
  createdAt: string | null;
  isComplete: boolean;
  signers: {
    name: string;
    email: string;
    statusCode: string;
    signedAt: string | null;
    signOrder: number;
  }[];
}

interface ESignRequestsPage {
  data: ESignRequest[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
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
