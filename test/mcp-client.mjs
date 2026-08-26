/**
 * 用 stdio 跟 MCP server 講話的極簡 client,只為測試用。
 *
 * MCP 的 stdio 傳輸是「一行一個 JSON-RPC 訊息」。這裡做三件事:
 *   1. spawn 起 index.ts(用專案裡的 tsx,不靠 npx)
 *   2. 逐行拆出回應,用 id 對回發問的人
 *   3. 提供 callTool() 讓測試直接拿到工具回的文字
 *
 * ⚠️ server 的 log 都走 stderr(stdout 是 MCP 協定專用的),
 *    所以這裡把 stderr 收起來,測試失敗時才印出來幫忙除錯。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function startMcpServer(backendUrl) {
  const tsx = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  const child = spawn(tsx, [path.join(ROOT, 'index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      BACKEND_URL: backendUrl,
      BACKEND_EMAIL: 'test@example.com',
      BACKEND_PASSWORD: 'test-password',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });

  let nextId = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(
        () => reject(new Error(`MCP 請求逾時:${method}\n--- server stderr ---\n${stderr}`)),
        20000
      );
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  return {
    /** 回傳已註冊的工具名稱陣列 */
    async listToolNames() {
      const res = await request('tools/list', {});
      return res.result.tools.map((t) => t.name);
    },
    /** 呼叫工具,回 { text, isError } */
    async callTool(name, args = {}) {
      const res = await request('tools/call', { name, arguments: args });
      if (res.error) throw new Error(`tools/call 失敗:${JSON.stringify(res.error)}`);
      return {
        text: res.result.content.map((c) => c.text).join('\n'),
        isError: !!res.result.isError,
      };
    },
    get stderr() { return stderr; },
    stop() { child.kill(); },
  };
}
