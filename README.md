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

- `check_backend_health` — 檢查後端是否正常運作 (呼叫 `/api/health`)
- `search_purchase_orders` — 依關鍵字搜尋採購單,可選擇狀態碼篩選與筆數限制

## 開發環境設定

需求:Node.js 20+。

```bash
npm install
cp .env.example .env   # 然後填入 BACKEND_URL 與登入帳密
npm run dev            # 用 tsx 直接執行 index.ts
```

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
