# Procurement MCP Server

一個以 IT 採購流程為題的 MCP (Model Context Protocol) server 學習專案。
它把既有的採購後端 (REST API) 包裝成 AI 可呼叫的工具,讓 Claude 等 AI
能透過自然語言查詢採購資料。

## 架構

```
AI client ──(MCP / stdio)──▶ 本 server ──(HTTP + JWT)──▶ 採購後端 REST API
```

本 server 不做業務邏輯,只負責把後端能力轉成 MCP 工具,並處理登入與認證。

## 目前提供的工具

| 工具 | 說明 | 對應的後端端點 |
|------|------|----------------|
| `check_backend_health` | 檢查後端是否正常運作 | `GET /api/health` |
| `search_purchase_orders` | 依關鍵字搜尋採購單,可選狀態碼篩選與筆數限制 | `GET /api/purchase-orders/search` |
| `get_purchase_order_details` | 查單一採購單明細:品項、送達與付款資訊、發票、附件 | `GET /api/purchase-orders/search` + `GET /api/purchase-orders/:id/details` |
| `check_esign_status` | 查電子簽核進度與每位簽署人的狀態 | `GET /api/esign/requests` |

幾個實作上的注意事項:

- **`get_purchase_order_details` 會串接兩個後端呼叫。** 後端明細 API 的 `:id`
  是資料庫的數字 id,不是採購單號,所以工具先用搜尋把單號換成 id 再取明細。
  單號沒有完全命中時會列出相近選項請使用者指定,不會自己猜一筆。
- **後端的 `warning` 欄位會照實轉達。** 後端向 FreshService 取資料失敗時,
  回傳的品項會是空的並附上 `warning`。工具會明確說明這是「取不到」而不是
  「沒有」——否則 AI 會把失敗講成「這張單沒有品項」。
- **`check_esign_status` 依採購單查詢是「文字比對」,不是資料關聯。**
  後端的 `esign_requests` 表只存廠商、主旨與簽署人,**沒有採購單欄位**,
  所以只能比對簽核主旨裡有沒有出現單號或發票號。工具的輸出會標明這一點:
  比對不到不代表該採購單沒有送簽。若要真正的關聯,需要在後端的
  `esign_requests` 加上 `po_number` 之類的欄位。

## 開發環境設定

需求:Node.js 20+。

```bash
npm install
cp .env.example .env   # 然後填入 BACKEND_URL 與登入帳密
npm run dev            # 用 tsx 直接執行 index.ts
```

可用的 npm script:

| 指令 | 用途 |
|------|------|
| `npm run dev` | tsx watch,改檔就重啟 |
| `npm start` | tsx 直接跑一次 |
| `npm run build` | 用 tsc 編譯到 `dist/` |
| `npm run serve` | 跑編譯後的 `dist/index.js` |
| `npm test` | 跑回歸測試(見下) |

## 測試

```bash
npm test
```

測試會真的把 `index.ts` 跑起來,用 MCP 協定呼叫每個工具,後端則換成
`test/mock-backend.mjs`——一個回傳格式照著真後端抄的假後端。所以測到的是
整條路:zod 參數驗證 → 登入帶 token → 呼叫後端 → 後處理 → 排版輸出。
不需要啟動真的採購後端,也不會碰到網路。

```
test/
├── mock-backend.mjs   假後端(回傳格式對齊真後端的 route)
├── mcp-client.mjs     用 stdio 講 MCP 的極簡測試 client
└── tools.test.mjs     各工具的回歸測試
```

> ⚠️ 真後端改了回傳欄位時,`test/mock-backend.mjs` 也要跟著改,
> 否則測試會綠但實際是壞的。

## 環境變數 (.env)

| 變數 | 說明 |
|------|------|
| `BACKEND_URL` | 採購後端位置,預設 `http://localhost:3001` |
| `BACKEND_EMAIL` | 後端登入帳號 |
| `BACKEND_PASSWORD` | 後端登入密碼 |

> ⚠️ `.env` 含密碼,已被 `.gitignore` 忽略,請勿 commit。

## 連接到 Claude Desktop

在 `claude_desktop_config.json` 的 `mcpServers`(小寫)加入:

```json
{
  "mcpServers": {
    "procurement": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/index.ts"]
    }
  }
}
```

修改程式後需以 `Cmd+Q` 完整結束並重新開啟 Claude Desktop。
