# 蕃茄鐘:軟體 + 實體裝置整合

軟體蕃茄鐘、實體蕃茄鐘 (ESP32)、以及讓 Claude 查得到紀錄的 MCP server。
實體計時器走完時間時,紀錄會自動出現在軟體端。

## 為什麼是三支程式?

最直覺的想法是「MCP server 直接收裝置事件」,但**做不到**:

- `index.ts` 這類 MCP server 走 **stdio**,只在 Claude Desktop 開著時才活著
- stdio 沒有網路 port,ESP32 根本連不進來
- 而實體蕃茄鐘響的那一刻,你很可能沒開 Claude

所以事件必須送給一個「一直開著、有 port」的服務:

```
  ESP32 ──HTTP──▶  server.ts  ──▶ SQLite      ← 紀錄的唯一真相
 (實體)             (常駐後端)        │
                                      │ HTTP
  Claude ──MCP/stdio──▶ mcp.ts ───────┘        ← 只負責把資料變成 AI 能用的工具
```

| 檔案 | 角色 |
|------|------|
| `server.ts` | 常駐 REST 後端。收裝置事件、管軟體計時、寫 SQLite |
| `db.ts` | 資料層。schema 與所有查詢 |
| `mcp.ts` | MCP server。5 個工具給 Claude 呼叫 |
| `simulate-device.ts` | 模擬 ESP32,**沒有硬體也能測完整流程** |
| `firmware/main.py` | ESP32 / Pico W 的 MicroPython 韌體 |

資料庫用 Node 內建的 `node:sqlite`(Node 22.5+),**不需要 npm install 任何資料庫套件**。
啟動時 Node 會印一行 `ExperimentalWarning`,那是正常的。

## 快速開始(不需要硬體)

```bash
cp ../.env.example ../.env       # 若還沒有 .env
# 編輯 .env,把 POMODORO_DEVICE_TOKEN 換成一串隨機字串:
#   openssl rand -hex 16

npm run pomodoro:api             # 終端 A:啟動常駐後端 (port 3101)
npx tsx pomodoro/simulate-device.ts   # 終端 B:模擬實體裝置送事件
curl "http://localhost:3101/api/pomodoro/stats?period=today"
```

模擬器會跑四個情境,包含刻意製造的異常:

| 情境 | 模擬什麼 | 應該看到 |
|------|---------|---------|
| `normal` | 全程在線走完 25 分鐘 | 正常寫入一筆 |
| `offline` | 全程斷線,30 分鐘後才補送 | `ended_at` 是 30 分鐘前,不是現在 |
| `resend` | 同一個結束事件重送 3 次 | 只記 1 筆,其餘標記已去重 |
| `abort` | 7 分鐘後按鈕中斷 | 不計入完成顆數,計入中斷次數 |

單獨跑某個情境:`npx tsx pomodoro/simulate-device.ts offline`

## 接到 Claude Desktop

在 `claude_desktop_config.json` 的 `mcpServers` 加一個項目(跟採購那支並存):

```json
{
  "mcpServers": {
    "pomodoro": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/pomodoro/mcp.ts"]
    }
  }
}
```

⚠️ MCP server 只是「讀寫後端」,**`npm run pomodoro:api` 必須一直開著**,
否則工具會回報連不上。改完程式要 `Cmd+Q` 完整結束再開 Claude Desktop。

提供的工具:

| 工具 | 用途 |
|------|------|
| `check_pomodoro_backend` | 確認後端活著、裝置密鑰是否設定 |
| `start_pomodoro` | 開一顆軟體蕃茄鐘 |
| `finish_pomodoro` | 結束(完成 / 中斷) |
| `list_pomodoro_sessions` | 查紀錄,可只看實體裝置的 |
| `get_focus_stats` | 統計顆數、時數、依任務與來源分組 |

可以直接問 Claude:「我今天做了幾顆蕃茄鐘?」「實體計時器的紀錄有進來嗎?」

## 燒 ESP32 韌體

```bash
# 1. 刷 MicroPython 韌體(只要做一次)
#    https://micropython.org/download/ 下載對應開發板的 .bin
# 2. 裝 urequests(在 REPL 裡)
import mip; mip.install("urequests")
# 3. 改 firmware/main.py 最上面的設定,然後上傳
mpremote connect /dev/ttyUSB0 fs cp firmware/main.py :main.py
```

`main.py` 要改的四個值:

- `WIFI_SSID` / `WIFI_PASSWORD`
- `API_BASE` — 要用**電腦在區網裡的 IP**(例如 `http://192.168.1.100:3101`)。
  不能用 `localhost`,對 ESP32 來說那是它自己。
- `DEVICE_TOKEN` — 跟 `.env` 的 `POMODORO_DEVICE_TOKEN` 一致

接線:按鈕 GPIO15→GND、蜂鳴器 GPIO13、LED GPIO2(Pico W 把 `LED_PIN` 改成 `"LED"`)。

操作:按一下開始 25 分鐘(LED 亮);走完蜂鳴器響 3 聲;專注中再按一下 = 中斷。

## 真實硬體的三個坑,以及怎麼處理的

這部分是整個專案真正的技術重點 —— 這些不是理論問題,是接上硬體後一定會遇到的。

### 1. ESP32 沒有電池供電的 RTC,時間會歸零

**所以韌體完全不送絕對時間。** 它只送相對秒數:

- `elapsed_seconds` — 這顆蕃茄實際跑了幾秒(用單調遞增的 `ticks_ms` 量的)
- `age_seconds` — 這個事件是「幾秒前」發生的

後端收到後自己蓋時間戳:`ended_at = 現在 - age_seconds`。
裝置的時鐘準不準完全不影響紀錄正確性。

### 2. Wi-Fi 會斷,事件會重送

每顆蕃茄有一個 `session_uid`(裝置端寫在 flash 的計數器產生,跨斷電不重複)。
後端用它去重,而且更新時帶 `WHERE status = 'running'` 條件 ——
所以同一顆蕃茄的結束事件送一百次,時數也只會被算一次。

重複事件後端回 **200 而不是 4xx**:裝置要收到 2xx 才會把佇列裡那筆刪掉,
回 4xx 會讓它永遠卡在重送同一個事件。

### 3. 離線時開始的蕃茄,根本沒有「開始事件」

裝置離線時 `started` 事件送不出去,恢復連線後只會補送 `completed`。
後端因此允許「只有結束事件」的情況:用 `elapsed_seconds` 回推開始時間,
補一整筆完整紀錄(回應會帶 `backfilled: true`)。

另外還有一種**自我矛盾的紀錄**:開始事件在路上卡了很久才到,
導致 `started_at` 到 `ended_at` 只差幾秒、但 `actual_seconds` 寫 1500 秒。
後端偵測到差距超過 60 秒時,會相信裝置實測的 `elapsed`(單調計時器最可靠),
反推修正 `started_at`。

### 已知限制

**斷電後的 `age_seconds` 會失準。** `ticks_ms` 在重開機後歸零,
所以「斷電前排進佇列的事件」算不出正確的 age,會落在補送的時間點。
要精準就得加一顆 DS3231 RTC 模組(約 NT$50)。

## API

裝置端(需 `X-Device-Token` header):

| 端點 | 說明 |
|------|------|
| `GET /api/device/hello` | 確認 token、對時 |
| `POST /api/device/events` | 回報 `started` / `completed` / `aborted` |

`POST /api/device/events` 的 body:

```json
{
  "session_uid": "pomodoro-esp32-01-7",
  "type": "completed",
  "device_id": "pomodoro-esp32-01",
  "kind": "focus",
  "planned_seconds": 1500,
  "elapsed_seconds": 1500,
  "age_seconds": 0,
  "task": "寫採購報表"
}
```

軟體端 / MCP 用:

| 端點 | 說明 |
|------|------|
| `GET /api/health` | 健康檢查 |
| `POST /api/pomodoro/sessions` | 開始一顆(body: `task`, `minutes`, `kind`) |
| `POST /api/pomodoro/sessions/:id/finish` | 結束(body: `status`) |
| `GET /api/pomodoro/sessions` | 查紀錄(`from`/`to`/`source`/`status`/`kind`/`limit`) |
| `GET /api/pomodoro/stats` | 統計(`period=today\|yesterday\|week\|all`) |

實際專注秒數一律由後端依 `started_at` 計算,不接受呼叫端自己報一個數字。

## 設定

見 `../.env.example` 的蕃茄鐘區塊。最重要的兩個:

- `POMODORO_DEVICE_TOKEN` — **必填**,沒設定 `/api/device/*` 會一律回 500
  (刻意的:不會「預設放行」讓你誤以為有保護)
- `POMODORO_UTC_OFFSET_HOURS` — 台北填 8。資料存 UTC,這個值只決定
  「今天」從哪一刻算起,不然早上 8 點前的紀錄會被算到前一天

## 還沒做的部分

- **雙向同步**:目前是單向(裝置 → 後端)。若要「軟體按開始時實體裝置也跟著亮」,
  需要改用 MQTT 或 WebSocket
- **休息計時**:資料結構支援 `kind: 'break'`,但韌體只實作了專注
- **多裝置**:`device_id` 已經存了,但沒有依裝置分組的統計
