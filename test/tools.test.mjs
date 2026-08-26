/**
 * MCP 工具的回歸測試。
 *
 * 這些測試會真的把 index.ts 跑起來,用 MCP 協定呼叫工具,
 * 後端則換成 test/mock-backend.mjs(回傳格式照真後端抄)。
 * 所以測到的是「整條路」:zod 參數驗證 → 登入帶 token → 呼叫後端 →
 * 後處理 → 排版輸出。
 *
 * 執行:npm test
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBackend } from './mock-backend.mjs';
import { startMcpServer } from './mcp-client.mjs';

let backend;
let mcp;

before(async () => {
  backend = await startMockBackend();
  mcp = await startMcpServer(backend.url);
});

after(() => {
  mcp?.stop();
  backend?.server.close();
});

describe('工具註冊', () => {
  test('四個工具都註冊成功', async () => {
    const names = await mcp.listToolNames();
    assert.deepEqual(names.sort(), [
      'check_backend_health',
      'check_esign_status',
      'get_purchase_order_details',
      'search_purchase_orders',
    ]);
  });
});

describe('check_backend_health', () => {
  test('後端正常時回報成功', async () => {
    const { text, isError } = await mcp.callTool('check_backend_health');
    assert.equal(isError, false);
    assert.match(text, /後端正常運作/);
  });
});

describe('search_purchase_orders', () => {
  test('關鍵字搜尋回傳兩筆', async () => {
    const { text } = await mcp.callTool('search_purchase_orders', { q: '螢幕' });
    assert.match(text, /找到 2 筆採購單/);
    assert.match(text, /PO-0001/);
    assert.match(text, /PO-0002/);
  });

  test('limit 會截斷並回報總數(工具端後處理)', async () => {
    const { text } = await mcp.callTool('search_purchase_orders', { q: '螢幕', limit: 1 });
    assert.match(text, /找到 2 筆,顯示前 1 筆/);
  });

  test('status 篩選只留下該狀態(工具端後處理)', async () => {
    const { text } = await mcp.callTool('search_purchase_orders', { q: '螢幕', status: 25 });
    assert.match(text, /PO-0002/);
    assert.ok(!text.includes('PO-0001'), '狀態 25 不該出現 PO-0001(它是 15)');
  });

  test('數字狀態碼會翻成文字並保留原碼', async () => {
    const { text } = await mcp.callTool('search_purchase_orders', { q: 'PO-0001' });
    assert.match(text, /已下單\(15\)/);
  });

  test('查無資料時明確說找不到', async () => {
    const { text } = await mcp.callTool('search_purchase_orders', { q: '不存在的東西' });
    assert.match(text, /找不到/);
  });
});

describe('get_purchase_order_details', () => {
  test('用完整單號查:表頭 + 品項 + 發票 + 附件都在', async () => {
    const { text, isError } = await mcp.callTool('get_purchase_order_details', { po: 'PO-0001' });
    assert.equal(isError, false);
    assert.match(text, /採購單 PO-0001 — 設計部螢幕採購/);
    assert.match(text, /【採購品項】共 2 項/);
    assert.match(text, /ViewSonic VP2786-4K/);
    assert.match(text, /【基本資料】/);
    assert.match(text, /王小明 \/ 3F 設計部/);
    assert.match(text, /【發票】共 1 張/);
    assert.match(text, /INV-5566/);
    assert.match(text, /【附件】共 2 個/);
    assert.match(text, /已對應發票 INV-5566/);
    assert.match(text, /尚未處理/);
  });

  test('單號不完整時列出選項,不自己猜一筆', async () => {
    const { text } = await mcp.callTool('get_purchase_order_details', { po: '螢幕' });
    assert.match(text, /不是完整的採購單號/);
    assert.match(text, /PO-0001/);
    assert.match(text, /PO-0002/);
    // 不能因為猜了第一筆而印出明細
    assert.ok(!text.includes('【採購品項】'), '不該直接顯示某一筆的明細');
  });

  test('查不到的單號給明確訊息', async () => {
    const { text } = await mcp.callTool('get_purchase_order_details', { po: 'PO-9999' });
    assert.match(text, /找不到/);
  });

  test('後端帶 warning 時說明是「取不到」而非「沒有」', async () => {
    const { text } = await mcp.callTool('get_purchase_order_details', { po: '102' });
    assert.match(text, /無法從 FreshService 取得/);
    assert.match(text, /代表「取不到」,不代表「沒有」/);
    // 這是這個工具最重要的一條:不能謊稱這張單沒有品項
    assert.ok(
      !text.includes('【採購品項】無'),
      'FreshService 取不到時,不可以印「採購品項:無」——那是錯的答案'
    );
  });
});

describe('check_esign_status', () => {
  test('不給採購單時列出簽核請求與每位簽署人狀態', async () => {
    const { text, isError } = await mcp.callTool('check_esign_status');
    assert.equal(isError, false);
    assert.match(text, /共 2 筆簽核請求/);
    assert.match(text, /付款申請 - PO-0001 設計部螢幕/);
    assert.match(text, /已簽署\(signed\)/);
    assert.match(text, /等待簽署\(awaiting_signature\)/);
    assert.match(text, /✅ 已完成/);   // 第二筆
    assert.match(text, /測試模式/);     // 第一筆 testMode=true
  });

  test('給採購單且主旨有寫單號時比對得到,並標明是文字比對', async () => {
    const { text } = await mcp.callTool('check_esign_status', { po: 'PO-0001' });
    assert.match(text, /採購單 PO-0001/);
    assert.match(text, /沒有「採購單 ↔ 簽核請求」的關聯欄位/);
    assert.match(text, /只能算「可能相關」/);
    assert.match(text, /比對到 1 筆/);
    assert.match(text, /比對命中/);
  });

  test('比對不到時明講「不代表沒送簽」', async () => {
    const { text } = await mcp.callTool('check_esign_status', { po: 'PO-0002' });
    assert.match(text, /沒有比對到/);
    assert.match(text, /不代表這張採購單沒有送簽/);
  });

  test('用數字 id 查時說明無法比對,而不是回「找不到」', async () => {
    const { text } = await mcp.callTool('check_esign_status', { po: '102' });
    assert.match(text, /無法比對簽核請求/);
    assert.match(text, /請改用採購單號查詢/);
  });
});
