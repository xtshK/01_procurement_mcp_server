"""
============================================================
 實體蕃茄鐘韌體 (MicroPython · ESP32 / Raspberry Pi Pico W)
============================================================

 這是「實體蕃茄鐘」本體。它做四件事:

   1. 按一下按鈕 → 開始倒數 25 分鐘(LED 亮著表示專注中)
   2. 倒數結束   → 蜂鳴器響,並回報一筆 completed 事件給後端
   3. 專注中再按 → 中斷,回報 aborted 事件
   4. 沒網路時   → 事件寫進佇列檔,恢復連線後自動補送

 ── 硬體接線(ESP32)──────────────────────────────────────
   按鈕:GPIO 15 ── 按鈕 ── GND      (用內建上拉,按下讀到 0)
   蜂鳴器:GPIO 13 ── 蜂鳴器 ── GND   (無源蜂鳴器用 PWM;有源的改用 Pin.value)
   LED:GPIO 2(多數 ESP32 開發板的板載 LED)

 ── Pico W 的差異 ────────────────────────────────────────
   板載 LED 是 Pin("LED"),把下面 LED_PIN 改成 "LED" 即可;其餘相同。

 ── 需要的套件 ───────────────────────────────────────────
   urequests 不在韌體內建,先在 REPL 裝一次:
       import mip; mip.install("urequests")

 ── 為什麼程式碼是這樣寫的 ────────────────────────────────
   ESP32 沒有電池供電的 RTC,一斷電時間就歸零,所以這支韌體
   「完全不處理絕對時間」——倒數用單調遞增的 ticks_ms,回報時
   只送相對秒數,讓後端去蓋真正的時間戳。這是刻意的設計。
============================================================
"""

import json
import machine
import network
import os
import time

import urequests

# ── 使用者設定 ─────────────────────────────────────────────
WIFI_SSID = "your-wifi-ssid"
WIFI_PASSWORD = "your-wifi-password"

# 後端位置。注意要用「電腦在區網裡的 IP」,不能用 localhost ——
# 對 ESP32 來說 localhost 是它自己。
API_BASE = "http://192.168.1.100:3101"
# 必須跟後端 .env 的 POMODORO_DEVICE_TOKEN 一致
DEVICE_TOKEN = "change-me"
DEVICE_ID = "pomodoro-esp32-01"

FOCUS_SECONDS = 25 * 60
LONG_PRESS_MS = 1500  # 長按超過這個時間 = 強制中斷

BUTTON_PIN = 15
BUZZER_PIN = 13
LED_PIN = 2  # Pico W 改成 "LED"

# 離線時事件暫存在這個檔。用檔案而不是記憶體,才能撐過斷電。
QUEUE_FILE = "queue.json"
# 記錄「開過幾顆蕃茄」的計數器,用來產生不重複的 session_uid
COUNTER_FILE = "counter.txt"

# ── 硬體初始化 ─────────────────────────────────────────────
button = machine.Pin(BUTTON_PIN, machine.Pin.IN, machine.Pin.PULL_UP)
led = machine.Pin(LED_PIN, machine.Pin.OUT)
buzzer = machine.PWM(machine.Pin(BUZZER_PIN))
buzzer.duty_u16(0)


def beep(times=1, ms=120, freq=2000):
    """嗶幾聲。用無源蜂鳴器 + PWM;有源蜂鳴器把 PWM 換成 Pin.value(1/0)。"""
    for _ in range(times):
        buzzer.freq(freq)
        buzzer.duty_u16(30000)
        time.sleep_ms(ms)
        buzzer.duty_u16(0)
        time.sleep_ms(ms)


# ── 產生不重複的 session_uid ───────────────────────────────
def next_session_uid():
    """
    session_uid 是後端去重的依據,必須「跨斷電」都不重複。
    所以計數器要寫進檔案裡,不能只放在記憶體。
    格式:<device_id>-<第幾顆>
    """
    count = 0
    try:
        with open(COUNTER_FILE) as f:
            count = int(f.read().strip() or "0")
    except (OSError, ValueError):
        count = 0
    count += 1
    with open(COUNTER_FILE, "w") as f:
        f.write(str(count))
    return "%s-%d" % (DEVICE_ID, count)


# ── 離線佇列 ───────────────────────────────────────────────
def load_queue():
    try:
        with open(QUEUE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def save_queue(queue):
    with open(QUEUE_FILE, "w") as f:
        json.dump(queue, f)


def enqueue(event):
    """
    把事件排進佇列。同時記下「排進來時的 ticks」,
    等真正送出去時就能算出這個事件是幾秒前發生的(age_seconds),
    後端才能把離線期間的紀錄補回正確的時間點。
    """
    queue = load_queue()
    event["_enqueued_ticks"] = time.ticks_ms()
    queue.append(event)
    save_queue(queue)


def post_event(event):
    """送一筆事件。回傳 True 表示後端確實收下了(可以從佇列刪掉)。"""
    payload = {k: v for k, v in event.items() if not k.startswith("_")}

    # 算出這個事件是「幾秒前」發生的。
    # ⚠️ 斷電重開後 ticks_ms 會歸零,delta 會變成負數或亂數 ——
    #    這種情況我們就放棄回推、送 0(紀錄會落在補送的時間點)。
    #    這是這個設計已知的限制:要精準就得加一顆 RTC 模組(DS3231)。
    enqueued = event.get("_enqueued_ticks")
    age = 0
    if enqueued is not None:
        delta = time.ticks_diff(time.ticks_ms(), enqueued)
        if delta > 0:
            age = delta // 1000
    payload["age_seconds"] = age

    try:
        res = urequests.post(
            API_BASE + "/api/device/events",
            headers={
                "Content-Type": "application/json",
                "X-Device-Token": DEVICE_TOKEN,
            },
            data=json.dumps(payload),
        )
        status = res.status_code
        res.close()
        # 2xx = 收下了。4xx 也要當成「處理完了」並丟掉這筆 ——
        # 格式錯誤或 token 錯誤重送一萬次也不會變對,只會塞住佇列。
        # 只有 5xx 和連不上才值得留著重試。
        if 200 <= status < 500:
            return True
        print("後端回應", status, "稍後重試")
        return False
    except Exception as exc:  # 網路類錯誤:留在佇列裡下次再試
        print("送出失敗,留在佇列:", exc)
        return False


def flush_queue():
    """把佇列裡積壓的事件依序送出。送不掉就停下,保持順序。"""
    queue = load_queue()
    if not queue:
        return
    remaining = list(queue)
    while remaining:
        if not post_event(remaining[0]):
            break
        remaining.pop(0)
    if len(remaining) != len(queue):
        save_queue(remaining)
        print("佇列剩下", len(remaining), "筆")


def report(event):
    """回報一個事件:先排進佇列,再試著把整個佇列送出去。

    為什麼不直接送?因為「先寫佇列」才不會在送出瞬間斷電就掉資料,
    而且能保證事件順序(started 一定排在 completed 前面)。
    """
    enqueue(event)
    flush_queue()


# ── Wi-Fi ─────────────────────────────────────────────────
wlan = network.WLAN(network.STA_IF)


def ensure_wifi(timeout_ms=15000):
    """確保 Wi-Fi 連上。連不上就回 False —— 離線照樣可以計時。"""
    if wlan.isconnected():
        return True
    wlan.active(True)
    wlan.connect(WIFI_SSID, WIFI_PASSWORD)
    start = time.ticks_ms()
    while not wlan.isconnected():
        if time.ticks_diff(time.ticks_ms(), start) > timeout_ms:
            print("Wi-Fi 連線逾時,進入離線模式")
            return False
        time.sleep_ms(200)
    print("Wi-Fi 已連線:", wlan.ifconfig()[0])
    return True


# ── 按鈕:回傳 None / "short" / "long" ──────────────────────
def read_button():
    if button.value() == 1:  # 上拉,1 = 沒按
        return None
    pressed_at = time.ticks_ms()
    # 等放開(順便消除彈跳)
    while button.value() == 0:
        if time.ticks_diff(time.ticks_ms(), pressed_at) > LONG_PRESS_MS:
            beep(1, 60)
            while button.value() == 0:
                time.sleep_ms(20)
            return "long"
        time.sleep_ms(20)
    if time.ticks_diff(time.ticks_ms(), pressed_at) < 50:
        return None  # 太短,當雜訊
    return "short"


# ── 一顆蕃茄鐘的完整流程 ───────────────────────────────────
def run_focus_session():
    uid = next_session_uid()
    print("開始蕃茄鐘", uid)
    beep(1)
    led.value(1)

    report(
        {
            "session_uid": uid,
            "type": "started",
            "device_id": DEVICE_ID,
            "kind": "focus",
            "planned_seconds": FOCUS_SECONDS,
        }
    )

    # 倒數。用 ticks_diff 而不是「累加 sleep 的秒數」——
    # sleep 會被網路請求拖慢,累加法會越走越慢。
    started = time.ticks_ms()
    aborted = False
    while True:
        elapsed_ms = time.ticks_diff(time.ticks_ms(), started)
        if elapsed_ms >= FOCUS_SECONDS * 1000:
            break
        if read_button() is not None:
            aborted = True
            break
        # 每 10 秒試著清一次佇列,把離線時積壓的紀錄補送上去
        if (elapsed_ms // 1000) % 10 == 0:
            if wlan.isconnected():
                flush_queue()
        time.sleep_ms(100)

    elapsed_seconds = time.ticks_diff(time.ticks_ms(), started) // 1000
    led.value(0)

    if aborted:
        print("中斷,實際", elapsed_seconds, "秒")
        beep(2, 80, 800)
        report(
            {
                "session_uid": uid,
                "type": "aborted",
                "device_id": DEVICE_ID,
                "kind": "focus",
                "planned_seconds": FOCUS_SECONDS,
                "elapsed_seconds": elapsed_seconds,
            }
        )
        return

    # ★ 這裡就是需求 (3):實體蕃茄鐘走完時間的那一刻
    print("走完了!實際", elapsed_seconds, "秒")
    beep(3, 200)  # 鈴聲
    # ★ 需求 (4):同一時間把紀錄送給後端,軟體端就查得到了
    ensure_wifi()
    report(
        {
            "session_uid": uid,
            "type": "completed",
            "device_id": DEVICE_ID,
            "kind": "focus",
            "planned_seconds": FOCUS_SECONDS,
            "elapsed_seconds": elapsed_seconds,
        }
    )


def main():
    led.value(0)
    ensure_wifi()
    # 開機先把上次斷電前沒送出去的事件補送掉
    flush_queue()
    print("待機中,按按鈕開始一顆蕃茄鐘")

    idle_ticks = time.ticks_ms()
    while True:
        if read_button() is not None:
            run_focus_session()
            print("待機中,按按鈕開始一顆蕃茄鐘")
            idle_ticks = time.ticks_ms()
        # 待機時每 30 秒重試一次連線與補送
        if time.ticks_diff(time.ticks_ms(), idle_ticks) > 30000:
            if ensure_wifi(5000):
                flush_queue()
            idle_ticks = time.ticks_ms()
        time.sleep_ms(50)


if __name__ == "__main__":
    main()
