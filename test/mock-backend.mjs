/**
 * 測試用的假採購後端。
 *
 * 回傳格式是照著真後端 01_Purchase_Process 的這幾支 route 抄的:
 *   routes/purchaseOrderSearch.ts   GET  /api/purchase-orders/search
 *   routes/purchaseOrderDetails.ts  GET  /api/purchase-orders/:id/details
 *   routes/esign.ts                 GET  /api/esign/requests
 *   routes/auth.ts                  POST /api/auth/login
 *
 * ⚠️ 真後端改了回傳欄位時,這裡也要跟著改,否則測試會綠但實際是壞的。
 */
import http from 'node:http';

export const PURCHASE_ORDERS = [
  { id: 101, po_number: 'PO-0001', name: '設計部螢幕採購', vendor_id: 'V1',
    total_cost: 120000, status: 15, expected_delivery_date: '2026-09-01', created_at: '2026-08-01' },
  { id: 102, po_number: 'PO-0002', name: '螢幕壁掛架', vendor_id: 'V2',
    total_cost: 8000, status: 25, expected_delivery_date: '2026-08-20', created_at: '2026-08-02' },
];

// 101 = 一切正常;102 = 後端抓 FreshService 失敗,帶 warning
export const DETAILS = {
  101: {
    purchase_items: [
      { item_name: 'ViewSonic VP2786-4K', description: '設計部色彩校正用',
        quantity: 2, unit_price: 55000, total_cost: 110000 },
      { item_name: 'DisplayPort 線材', description: null,
        quantity: 2, unit_price: 5000, total_cost: 10000 },
    ],
    info: { requestor_deliver_to: '王小明 / 3F 設計部', payment_terms: 30,
            date_of_order: '2026-08-01', shipping_address: '台北市內湖區' },
    invoices: [{ id: 9, invoice_number: 'INV-5566', total: 120000,
                 status: 'processed', source_filename: '/po/PO-0001-invoice.pdf' }],
    attachments: [
      { filename: 'PO-0001-invoice.pdf', path: '/po/PO-0001-invoice.pdf',
        processed: true, invoice_number: 'INV-5566' },
      { filename: 'PO-0001-quote.pdf', path: '/po/PO-0001-quote.pdf',
        processed: false, invoice_number: null },
    ],
  },
  102: {
    purchase_items: [], info: {}, invoices: [], attachments: [],
    warning: 'Failed to fetch PO details from FreshService',
  },
};

// 第 1 筆主旨寫了 PO-0001,所以文字比對找得到;第 2 筆跟任何採購單都對不上
export const ESIGN_REQUESTS = [
  {
    signatureRequestId: 'sig_aaa', vendor: 'ViewSonic',
    subject: '付款申請 - PO-0001 設計部螢幕', testMode: true,
    createdAt: '2026-08-10', isComplete: false,
    signers: [
      { name: '王小明', email: 'ming@example.com', statusCode: 'signed', signedAt: '2026-08-11', signOrder: 0 },
      { name: '李主管', email: 'lee@example.com', statusCode: 'awaiting_signature', signedAt: null, signOrder: 1 },
    ],
  },
  {
    signatureRequestId: 'sig_bbb', vendor: 'Herman Miller',
    subject: '付款申請 - 辦公椅', testMode: false,
    createdAt: '2026-08-05', isComplete: true,
    signers: [
      { name: '王小明', email: 'ming@example.com', statusCode: 'signed', signedAt: '2026-08-06', signOrder: 0 },
    ],
  },
];

/** 啟動假後端。listen(0) 讓 OS 給一個沒被佔用的 port,測試才不會互撞。 */
export function startMockBackend() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      return json(200, { token: 'fake-jwt', user: { email: 'a@b.c' } });
    }
    if (url.pathname === '/api/health') {
      return json(200, { status: 'ok', timestamp: '2026-08-26T00:00:00Z' });
    }

    // 其餘端點都要 Bearer token —— 順便驗證 MCP server 真的有帶
    if (!(req.headers.authorization || '').startsWith('Bearer ')) {
      return json(401, { error: 'unauthorized' });
    }

    if (url.pathname === '/api/purchase-orders/search') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      if (!q) return json(400, { error: 'Search query is required' });
      return json(200, {
        purchase_orders: PURCHASE_ORDERS.filter(
          (p) => (p.po_number || '').toLowerCase().includes(q) ||
                 (p.name || '').toLowerCase().includes(q)
        ),
      });
    }

    const m = url.pathname.match(/^\/api\/purchase-orders\/(\d+)\/details$/);
    if (m) {
      const d = DETAILS[Number(m[1])];
      return d ? json(200, d) : json(404, { error: 'PO not found' });
    }

    if (url.pathname === '/api/esign/requests') {
      const pageSize = Math.min(50, Number(url.searchParams.get('pageSize')) || 5);
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const offset = (page - 1) * pageSize;
      return json(200, {
        data: ESIGN_REQUESTS.slice(offset, offset + pageSize),
        page, pageSize,
        total: ESIGN_REQUESTS.length,
        totalPages: Math.ceil(ESIGN_REQUESTS.length / pageSize) || 1,
      });
    }

    json(404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}
