/**
 * ============================================================
 *  實體蕃茄鐘「模擬器」—— 還沒買到 ESP32 也能測整條路
 * ============================================================
 *
 *  它做的事跟 firmware/main.py 完全一樣:往 /api/device/events
 *  POST 事件。差別只在它跑在你的電腦上,而且不用真的等 25 分鐘。
 *
 *  用法:
 *    npm run pomodoro:api                    # 另一個終端先開著後端
 *    npx tsx pomodoro/simulate-device.ts     # 跑完整劇本(含異常情境)
 *    npx tsx pomodoro/simulate-device.ts normal   # 只跑一個情境
 *
 *  可用情境:normal / offline / resend / abort / all(預設)
 * ============================================================
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const API_URL =
  process.env.POMODORO_API_URL ?? `http://localhost:${process.env.POMODORO_PORT ?? 3101}`;
const DEVICE_TOKEN = process.env.POMODORO_DEVICE_TOKEN ?? '';
const DEVICE_ID = 'simulator-01';
const FOCUS_SECONDS = 25 * 60;

interface DeviceEvent {
  session_uid: string;
  type: 'started' | 'completed' | 'aborted';
  device_id?: string;
  kind?: 'focus' | 'break';
  planned_seconds?: number;
  elapsed_seconds?: number;
  age_seconds?: number;
  task?: string;
}

async function send(event: DeviceEvent): Promise<void> {
  const res = await fetch(`${API_URL}/api/device/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Token': DEVICE_TOKEN },
    body: JSON.stringify(event),
  });
  const body = (await res.json()) as {
    session?: { id: number; status: string; actual_seconds: number | null };
    error?: string;
    deduplicated?: boolean;
    backfilled?: boolean;
  };

  if (!res.ok) {
    console.log(`  ✗ ${event.type} → HTTP ${res.status}:${body.error}`);
    return;
  }
  const flags = [
    body.deduplicated ? '已去重(沒有重複記錄)' : null,
    body.backfilled ? '離線補記' : null,
  ]
    .filter(Boolean)
    .join(' / ');
  console.log(
    `  ✓ ${event.type} → #${body.session?.id} status=${body.session?.status}` +
      ` actual=${body.session?.actual_seconds ?? '-'}s${flags ? ` [${flags}]` : ''}`
  );
}

// 每個情境用不重複的 uid,重跑腳本時才不會被去重機制擋掉。
// 真實裝置是用「寫在 flash 裡的計數器」達到同樣效果(見 firmware 的 next_session_uid)。
let seq = Date.now() % 100000;
const uid = (label: string) => `${DEVICE_ID}-${label}-${seq++}`;

// ── 情境 1:正常走完一顆蕃茄 ────────────────────────────────
async function scenarioNormal() {
  console.log('\n【情境 1】正常走完 25 分鐘(裝置全程在線)');
  const u = uid('normal');
  await send({
    session_uid: u,
    type: 'started',
    device_id: DEVICE_ID,
    kind: 'focus',
    planned_seconds: FOCUS_SECONDS,
    task: '模擬:寫程式',
  });
  // 真實裝置會等 25 分鐘;這裡直接跳到結束,並用 elapsed_seconds 告訴後端跑了多久
  await send({
    session_uid: u,
    type: 'completed',
    kind: 'focus',
    planned_seconds: FOCUS_SECONDS,
    elapsed_seconds: FOCUS_SECONDS,
    age_seconds: 0,
  });
  console.log('  ↳ 後端會發現「開始/結束事件只隔幾毫秒但實測 1500 秒」,自動回推開始時間');
}

// ── 情境 2:整段離線,恢復後才補送 ──────────────────────────
async function scenarioOffline() {
  console.log('\n【情境 2】Wi-Fi 全程斷線,蕃茄走完 30 分鐘後才恢復連線');
  const u = uid('offline');
  // started 事件當時送不出去,所以「根本沒有」這個事件 —— 只補送結束事件。
  // age_seconds=1800 表示「這顆蕃茄是 30 分鐘前響的」。
  await send({
    session_uid: u,
    type: 'completed',
    device_id: DEVICE_ID,
    kind: 'focus',
    planned_seconds: FOCUS_SECONDS,
    elapsed_seconds: FOCUS_SECONDS,
    age_seconds: 1800,
    task: '模擬:離線專注',
  });
  console.log('  ↳ 紀錄的 ended_at 會是 30 分鐘前,不是現在 —— 時間軸才正確');
}

// ── 情境 3:同一個事件重送三次 ──────────────────────────────
async function scenarioResend() {
  console.log('\n【情境 3】網路不穩,同一個結束事件重送 3 次');
  const u = uid('resend');
  await send({
    session_uid: u,
    type: 'started',
    device_id: DEVICE_ID,
    kind: 'focus',
    planned_seconds: FOCUS_SECONDS,
  });
  for (let i = 1; i <= 3; i++) {
    process.stdout.write(`  第 ${i} 次:`);
    await send({
      session_uid: u,
      type: 'completed',
      kind: 'focus',
      planned_seconds: FOCUS_SECONDS,
      elapsed_seconds: FOCUS_SECONDS,
    });
  }
  console.log('  ↳ 只有第 1 次真的寫入,後兩次被去重 —— 專注時數不會被算成 75 分鐘');
}

// ── 情境 4:中途按鈕放棄 ────────────────────────────────────
async function scenarioAbort() {
  console.log('\n【情境 4】專注 7 分鐘後按鈕中斷');
  const u = uid('abort');
  await send({
    session_uid: u,
    type: 'started',
    device_id: DEVICE_ID,
    kind: 'focus',
    planned_seconds: FOCUS_SECONDS,
    task: '模擬:被會議打斷',
  });
  await send({
    session_uid: u,
    type: 'aborted',
    kind: 'focus',
    planned_seconds: FOCUS_SECONDS,
    elapsed_seconds: 7 * 60,
  });
  console.log('  ↳ 中斷的蕃茄不計入「完成顆數」,但會計入中斷次數');
}

async function main() {
  if (!DEVICE_TOKEN) {
    console.error('✗ .env 裡沒有 POMODORO_DEVICE_TOKEN,後端會拒絕所有裝置事件。請先設定。');
    process.exit(1);
  }

  // 先確認後端活著,不然下面每個情境都會噴一樣的連線錯誤
  try {
    const res = await fetch(`${API_URL}/api/device/hello`, {
      headers: { 'X-Device-Token': DEVICE_TOKEN },
    });
    if (res.status === 401) {
      console.error('✗ X-Device-Token 不正確:模擬器與後端的 .env 不一致?');
      process.exit(1);
    }
    if (!res.ok) {
      console.error(`✗ 後端回應異常:HTTP ${res.status}`);
      process.exit(1);
    }
  } catch {
    console.error(`✗ 連不上蕃茄鐘後端 (${API_URL})。請先執行:npm run pomodoro:api`);
    process.exit(1);
  }

  console.log(`模擬實體蕃茄鐘 → ${API_URL}`);

  const scenarios: Record<string, () => Promise<void>> = {
    normal: scenarioNormal,
    offline: scenarioOffline,
    resend: scenarioResend,
    abort: scenarioAbort,
  };

  const which = process.argv[2] ?? 'all';
  if (which === 'all') {
    for (const run of Object.values(scenarios)) await run();
  } else if (scenarios[which]) {
    await scenarios[which]();
  } else {
    console.error(`未知的情境「${which}」,可用:${Object.keys(scenarios).join(' / ')} / all`);
    process.exit(1);
  }

  console.log('\n完成。用 Claude 問「我今天做了幾顆蕃茄鐘?」或直接看:');
  console.log(`  curl "${API_URL}/api/pomodoro/stats?period=today"`);
}

main();
