// Load / stress test for the collaboration service.
//
//   node scripts/stress.js [users] [opsPerUser] [workspaceId]
//
// Creates users + a workspace via the REST API, then drives N simulated
// clients over Socket.IO submitting canvas operations. Reports latency
// percentiles (ack round-trip), throughput, and sync failures.
//
// Prerequisites: Next.js dev server (:3000) + collab service (:3003).

const { io } = require("socket.io-client");

const USERS = parseInt(process.argv[2] || "10", 10);
const OPS = parseInt(process.argv[3] || "50", 10);
const BASE = process.env.STRESS_BASE || "http://127.0.0.1:3000";
const ORIGIN = process.env.STRESS_ORIGIN || "http://127.0.0.1:81";

const PALETTE = ["#ef4444", "#f59e0b", "#10b981", "#06b6d4", "#8b5cf6"];

async function api(path, opts = {}, cookie) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(opts.headers || {}),
    },
  });
  const setCookie = res.headers.get("set-cookie");
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data, cookie: setCookie ? setCookie.split(";")[0] : cookie };
}

function makeClient(label, cookie) {
  const token = /iw_session=([^;]+)/.exec(cookie)?.[1];
  const socket = io(ORIGIN + "/?XTransformPort=3003", {
    transports: ["websocket"],
    auth: { token },
    reconnection: false,
    timeout: 8000,
  });
  return socket;
}

function emitAck(socket, event, payload, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ error: "timeout" }), timeoutMs);
    socket.emit(event, payload, (res) => {
      clearTimeout(t);
      resolve(res || {});
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`stress: ${USERS} users × ${OPS} ops → ${BASE}`);
  const latencies = [];
  let failures = 0;
  let applied = 0;

  // bootstrap: create users + workspace via REST
  const cookieJar = [];
  for (let i = 0; i < USERS; i++) {
    const username = `stress_${Date.now().toString(36)}_${i}`;
    const { cookie } = await api("/api/auth", {
      method: "POST",
      body: JSON.stringify({ mode: "register", username, password: "stress-test-6" }),
    });
    cookieJar.push(cookie);
  }
  const { data: wsData } = await api("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: "stress-run" }),
  }, cookieJar[0]);
  const workspaceId = wsData.workspace.id;
  console.log("workspace:", workspaceId);

  // every simulated user joins as a member (share-by-id)
  for (const cookie of cookieJar) {
    await api(`/api/workspaces/${workspaceId}/join`, { method: "POST" }, cookie);
  }

  const started = Date.now();
  const runId = Date.now().toString(36); // globally-unique object ids per run

  await Promise.all(
    cookieJar.map((cookie, i) => new Promise(async (resolve) => {
      const socket = makeClient(`u${i}`, cookie);
      socket.on("connect_error", (e) => { console.log(`u${i} connect_error:`, e.message); failures++; resolve(); });
      socket.on("connect", async () => {
        const join = await emitAck(socket, "ws:join", { workspaceId });
        if (join.error) { console.log(`u${i} join failed:`, join.error); failures++; socket.disconnect(); return resolve(); }

        for (let o = 0; o < OPS; o++) {
          const oid = `obj_${runId}_${i}_${o}`;
          const t0 = Date.now();
          const res = await emitAck(socket, "canvas:op", {
            ops: [{
              id: `s${i}_${o}`,
              type: "create",
              oid,
              p: {
                object: {
                  id: oid,
                  type: "rectangle",
                  x: (i * 50 + o * 3) % 2000,
                  y: (o * 17) % 1200,
                  w: 60,
                  h: 40,
                  rot: 0,
                  style: { fill: PALETTE[i % 5], stroke: "#31405c", strokeWidth: 2 },
                  data: {},
                },
              },
            }],
          });
          const ack = await emitAck(socket, "canvas:op", {
            ops: [{ id: `m${i}_${o}`, type: "move", oid, p: { dx: 5, dy: -3 } }],
          });
          if (res.error || ack.error) failures++;
          else {
            applied += 2;
            latencies.push(Date.now() - t0);
          }
          await sleep(5);
        }
        socket.disconnect();
        resolve();
      });
    }))
  );

  const wall = Date.now() - started;
  latencies.sort((a, b) => a - b);
  const pct = (p) => (latencies.length ? latencies[Math.floor((p / 100) * latencies.length)] : -1);

  console.log("──────────────────────────────────────");
  console.log(`wall time          ${wall}ms`);
  console.log(`operations applied ${applied} (${((applied / wall) * 1000).toFixed(0)}/s)`);
  console.log(`failures           ${failures}`);
  if (latencies.length) {
    console.log(`ack latency  p50   ${pct(50)}ms`);
    console.log(`ack latency  p95   ${pct(95)}ms`);
    console.log(`ack latency  p99   ${pct(99)}ms`);
    console.log(`ack latency  max    ${latencies[latencies.length - 1]}ms`);
  }
  // verify convergence: every client sees the same version
  const check = makeClient("check", cookieJar[0]);
  check.on("connect", async () => {
    const join = await emitAck(check, "ws:join", { workspaceId });
    console.log(`final version      ${join.version} (expected ${USERS * OPS * 2})`);
    console.log(`objects on server  ${join.objects.length}`);
    const ok = join.version === USERS * OPS * 2 && join.objects.length === USERS * OPS && failures === 0;
    console.log(ok ? "✓ STRESS PASS" : "✗ STRESS FAIL");
    check.disconnect();
    process.exit(ok ? 0 : 1);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
