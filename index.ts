/**
 * ============================================================
 *  採購流程 MCP Server —— 第一階段 · 第三步
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
