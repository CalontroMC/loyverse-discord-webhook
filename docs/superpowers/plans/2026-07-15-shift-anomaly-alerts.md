# Shift Anomaly Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send one deduplicated Discord alert immediately after a Loyverse shift closes when cash differs by at least 1 baht, an individual Pay Out exceeds 1,000 baht, or a Pay Out has no reason.

**Architecture:** Add a pure module that detects and formats shift anomalies, while `index.js` continues to own webhook routing, the full-shift API fetch, recent-shift deduplication, and Discord delivery. The webhook acknowledges Loyverse first, fetches `GET /v1.0/shifts/{shift_id}` with bounded retry in background, and sends nothing for a normal shift.

**Tech Stack:** Node.js CommonJS, Express, Axios, Luxon, Discord webhooks, Node built-in test runner.

## Global Constraints

- Cash discrepancy alerts when `Math.abs(actual_cash - expected_cash) >= 1` baht.
- High-value Pay Out alerts only when the individual absolute amount is strictly greater than 1,000 baht; exactly 1,000 baht does not alert.
- A blank, missing, or whitespace-only Pay Out reason always alerts.
- A movement matching two rules appears once and carries both warning labels.
- Discord output must never contain an employee name or employee ID.
- Movement times use `Asia/Bangkok`; malformed numbers must never render as `NaN`.
- One anomalous shift produces one combined Discord embed; a normal shift produces no anomaly message.
- Recent shift IDs remain deduplicated in memory for 24 hours.
- Full-shift fetching retries transient failures at most three times.
- Existing receipt, inventory, daily report, and monthly report behavior remains unchanged.

## File Structure

- Create `lib/shiftAnomalyAlerts.js`: pure anomaly detection and Discord embed formatting.
- Create `test/shiftAnomalyAlerts.test.js`: boundary, formatting, privacy, and malformed-input tests.
- Create `test/shiftWebhookIntegration.test.js`: retry, shift-event routing, full-shift fetching, and deduplication tests.
- Modify `index.js`: import the pure helpers, recognize `shifts.create`, fetch the full shift, retain recent shift IDs, and send the alert.

---

### Task 1: Detect and Format Shift Anomalies

**Files:**
- Create: `lib/shiftAnomalyAlerts.js`
- Create: `test/shiftAnomalyAlerts.test.js`

**Interfaces:**
- Consumes: a Loyverse shift object and optional `{ discrepancyThreshold, highPayOutThreshold }` numeric thresholds.
- Produces: `detectShiftAnomalies(shift, options): ShiftAnomalies` and `formatShiftAnomalyDiscord(anomalies): object | null`.
- `ShiftAnomalies` shape: `{ hasAnomaly, closedAt, discrepancy, payOuts }`, where `discrepancy` is `null` or `{ amount, direction }` and each Pay Out is `{ time, amount, reason, warnings }`.

- [ ] **Step 1: Write failing boundary and normalization tests**

Create `test/shiftAnomalyAlerts.test.js` with:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectShiftAnomalies,
  formatShiftAnomalyDiscord,
} = require("../lib/shiftAnomalyAlerts");

function shift(overrides = {}) {
  return {
    id: "shift-secret-id",
    closed_at: "2026-07-15T10:00:00.000Z",
    expected_cash: 1000,
    actual_cash: 1000,
    opened_by_employee: "employee-open-secret",
    closed_by_employee: "employee-close-secret",
    cash_movements: [],
    ...overrides,
  };
}

test("alerts at a 1 baht discrepancy but not at 0.99", () => {
  assert.equal(
    detectShiftAnomalies(shift({ actual_cash: 1000.99 })).hasAnomaly,
    false
  );

  const result = detectShiftAnomalies(shift({ actual_cash: 1001 }));
  assert.deepEqual(result.discrepancy, { amount: 1, direction: "OVER" });
});

test("distinguishes cash shortage from cash overage", () => {
  assert.deepEqual(
    detectShiftAnomalies(shift({ actual_cash: 998 })).discrepancy,
    { amount: -2, direction: "SHORT" }
  );
  assert.deepEqual(
    detectShiftAnomalies(shift({ actual_cash: 1002 })).discrepancy,
    { amount: 2, direction: "OVER" }
  );
});

test("alerts above 1000 baht but not at exactly 1000", () => {
  const result = detectShiftAnomalies(
    shift({
      cash_movements: [
        { type: "PAY_OUT", money_amount: 1000, comment: "ซื้อของ", created_at: "2026-07-15T08:00:00Z" },
        { type: "PAY_OUT", money_amount: 1000.01, comment: "ซื้อของเพิ่ม", created_at: "2026-07-15T09:00:00Z" },
      ],
    })
  );

  assert.equal(result.payOuts.length, 1);
  assert.equal(result.payOuts[0].amount, 1000.01);
  assert.deepEqual(result.payOuts[0].warnings, ["HIGH_AMOUNT"]);
});

test("alerts for blank Pay Out reasons", () => {
  const result = detectShiftAnomalies(
    shift({
      cash_movements: [
        { type: "PAY_OUT", money_amount: 50, comment: "   ", created_at: "2026-07-15T08:00:00Z" },
      ],
    })
  );

  assert.equal(result.payOuts[0].reason, "ไม่ระบุเหตุผล");
  assert.deepEqual(result.payOuts[0].warnings, ["MISSING_REASON"]);
});

test("lists one movement once when it matches both Pay Out rules", () => {
  const result = detectShiftAnomalies(
    shift({
      cash_movements: [
        { type: "PAY_OUT", money_amount: -1500, comment: null, created_at: "2026-07-15T08:00:00Z" },
      ],
    })
  );

  assert.equal(result.payOuts.length, 1);
  assert.equal(result.payOuts[0].amount, 1500);
  assert.deepEqual(result.payOuts[0].warnings, ["HIGH_AMOUNT", "MISSING_REASON"]);
});

test("formats Bangkok time and excludes employee and shift identifiers", () => {
  const anomalies = detectShiftAnomalies(
    shift({
      actual_cash: 998,
      cash_movements: [
        { type: "PAY_OUT", money_amount: 1200, comment: "ค่าของ", employee_id: "employee-movement-secret", created_at: "2026-07-15T01:30:00Z" },
      ],
    })
  );
  const embed = formatShiftAnomalyDiscord(anomalies);
  const serialized = JSON.stringify(embed);

  assert.match(serialized, /08:30/);
  assert.match(serialized, /เงินขาด/);
  assert.doesNotMatch(serialized, /employee/);
  assert.doesNotMatch(serialized, /shift-secret-id/);
});

test("malformed numbers do not produce NaN and a normal shift has no embed", () => {
  const anomalies = detectShiftAnomalies(
    shift({
      expected_cash: "bad",
      actual_cash: null,
      cash_movements: [
        { type: "PAY_OUT", money_amount: "bad", comment: "ปกติ" },
      ],
    })
  );

  assert.equal(anomalies.hasAnomaly, false);
  assert.equal(formatShiftAnomalyDiscord(anomalies), null);
  assert.doesNotMatch(JSON.stringify(anomalies), /NaN/);
});
```

- [ ] **Step 2: Run the new test and verify the module is missing**

Run: `node --test test/shiftAnomalyAlerts.test.js`

Expected: FAIL with `Cannot find module '../lib/shiftAnomalyAlerts'`.

- [ ] **Step 3: Implement the pure detector and formatter**

Create `lib/shiftAnomalyAlerts.js`:

```js
const { DateTime } = require("luxon");

const BANGKOK_ZONE = "Asia/Bangkok";
const DEFAULT_DISCREPANCY_THRESHOLD = 1;
const DEFAULT_HIGH_PAY_OUT_THRESHOLD = 1000;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function bangkokTime(value) {
  const parsed = DateTime.fromISO(value || "", { setZone: true });
  return parsed.isValid
    ? parsed.setZone(BANGKOK_ZONE).toFormat("HH:mm")
    : "ไม่ทราบเวลา";
}

function detectShiftAnomalies(shift = {}, options = {}) {
  const discrepancyThreshold =
    options.discrepancyThreshold ?? DEFAULT_DISCREPANCY_THRESHOLD;
  const highPayOutThreshold =
    options.highPayOutThreshold ?? DEFAULT_HIGH_PAY_OUT_THRESHOLD;
  const difference =
    finiteNumber(shift.actual_cash) - finiteNumber(shift.expected_cash);
  const discrepancy =
    Math.abs(difference) >= discrepancyThreshold
      ? { amount: difference, direction: difference < 0 ? "SHORT" : "OVER" }
      : null;

  const payOuts = (Array.isArray(shift.cash_movements)
    ? shift.cash_movements
    : [])
    .filter((movement) => movement && movement.type === "PAY_OUT")
    .map((movement) => {
      const amount = Math.abs(finiteNumber(movement.money_amount));
      const rawReason =
        typeof movement.comment === "string" ? movement.comment.trim() : "";
      const warnings = [];
      if (amount > highPayOutThreshold) warnings.push("HIGH_AMOUNT");
      if (!rawReason) warnings.push("MISSING_REASON");
      return {
        time: bangkokTime(movement.created_at),
        amount,
        reason: rawReason || "ไม่ระบุเหตุผล",
        warnings,
      };
    })
    .filter((movement) => movement.warnings.length > 0);

  return {
    hasAnomaly: Boolean(discrepancy || payOuts.length),
    closedAt: shift.closed_at || null,
    discrepancy,
    payOuts,
  };
}

function formatShiftAnomalyDiscord(anomalies) {
  if (!anomalies || !anomalies.hasAnomaly) return null;

  const lines = [];
  if (anomalies.discrepancy) {
    const label =
      anomalies.discrepancy.direction === "SHORT" ? "เงินขาด" : "เงินเกิน";
    lines.push(
      `**${label}:** ฿${Math.abs(anomalies.discrepancy.amount).toFixed(2)}`
    );
  }

  if (anomalies.payOuts.length) {
    lines.push("", "**รายการนำเงินออกที่ต้องตรวจสอบ:**");
    for (const movement of anomalies.payOuts) {
      const warningLabels = movement.warnings.map((warning) =>
        warning === "HIGH_AMOUNT" ? "ยอดเกิน ฿1,000" : "ไม่ระบุเหตุผล"
      );
      lines.push(
        `- ${movement.time} — ฿${movement.amount.toFixed(2)} — ${movement.reason} (${warningLabels.join(", ")})`
      );
    }
  }

  return {
    title: "🚨 แจ้งเตือนความผิดปกติหลังปิดกะ",
    color: 0xe74c3c,
    description: lines.join("\n"),
    timestamp: anomalies.closedAt || new Date().toISOString(),
  };
}

module.exports = {
  detectShiftAnomalies,
  formatShiftAnomalyDiscord,
};
```

- [ ] **Step 4: Run the detector tests**

Run: `node --test test/shiftAnomalyAlerts.test.js`

Expected: 7 tests pass, 0 fail.

- [ ] **Step 5: Commit the detector**

```bash
git add lib/shiftAnomalyAlerts.js test/shiftAnomalyAlerts.test.js
git commit -m "feat: detect shift cash anomalies"
```

---

### Task 2: Fetch Full Shifts with Bounded Retry

**Files:**
- Modify: `index.js` near `fetchAllShifts`
- Create: `test/shiftWebhookIntegration.test.js`

**Interfaces:**
- Consumes: `shiftId: string`, the configured Axios client, and `LOYVERSE_ACCESS_TOKEN`.
- Produces: `fetchShiftByIdWithRetry(shiftId, options?): Promise<object>`.
- `options` supports injected `{ axiosClient, sleep, maxAttempts }` for deterministic tests; production defaults use Axios, a timer-backed sleep, and three attempts.

- [ ] **Step 1: Add a failing retry test that extracts the helper from `index.js`**

Create `test/shiftWebhookIntegration.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

function loadShiftFetch(axiosClient) {
  const start = source.indexOf("function isTransientShiftFetchError");
  const end = source.indexOf("async function fetchAllShifts", start);
  assert.notEqual(start, -1, "isTransientShiftFetchError must exist");
  assert.notEqual(end, -1, "fetchAllShifts boundary must exist");
  const context = vm.createContext({
    axios: axiosClient,
    LOYVERSE_ACCESS_TOKEN: "test-token",
    setTimeout,
  });
  return vm.runInContext(
    `(() => { ${source.slice(start, end)}; return fetchShiftByIdWithRetry; })()`,
    context
  );
}

test("fetchShiftByIdWithRetry retries transient failures and returns the full shift", async () => {
  let attempts = 0;
  const axiosClient = {
    async get(url, config) {
      attempts += 1;
      assert.equal(url, "https://api.loyverse.com/v1.0/shifts/shift-1");
      assert.equal(config.headers.Authorization, "Bearer test-token");
      if (attempts < 3) {
        const error = new Error("temporary");
        error.response = { status: 503 };
        throw error;
      }
      return { data: { id: "shift-1", cash_movements: [] } };
    },
  };
  const sleeps = [];
  const fetchShift = loadShiftFetch(axiosClient);

  const result = await fetchShift("shift-1", {
    axiosClient,
    maxAttempts: 3,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  assert.equal(result.id, "shift-1");
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [250, 500]);
});

test("fetchShiftByIdWithRetry does not retry a permanent 404", async () => {
  let attempts = 0;
  const axiosClient = {
    async get() {
      attempts += 1;
      const error = new Error("missing");
      error.response = { status: 404 };
      throw error;
    },
  };
  const fetchShift = loadShiftFetch(axiosClient);

  await assert.rejects(
    fetchShift("missing", { axiosClient, sleep: async () => {} }),
    /missing/
  );
  assert.equal(attempts, 1);
});
```

- [ ] **Step 2: Run the retry tests and verify the helper is missing**

Run: `node --test test/shiftWebhookIntegration.test.js`

Expected: FAIL with `fetchShiftByIdWithRetry must exist`.

- [ ] **Step 3: Add transient-error classification and the retrying fetch helper**

Insert before `fetchAllShifts` in `index.js`:

```js
function isTransientShiftFetchError(error) {
  const status = error && error.response && error.response.status;
  return !status || status === 429 || status >= 500;
}

async function fetchShiftByIdWithRetry(shiftId, options = {}) {
  const axiosClient = options.axiosClient || axios;
  const maxAttempts = options.maxAttempts || 3;
  const sleep =
    options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await axiosClient.get(
        `https://api.loyverse.com/v1.0/shifts/${encodeURIComponent(shiftId)}`,
        { headers: { Authorization: `Bearer ${LOYVERSE_ACCESS_TOKEN}` } }
      );
      return response.data;
    } catch (error) {
      if (attempt === maxAttempts || !isTransientShiftFetchError(error)) {
        throw error;
      }
      await sleep(250 * 2 ** (attempt - 1));
    }
  }
}
```

- [ ] **Step 4: Run the retry tests**

Run: `node --test test/shiftWebhookIntegration.test.js`

Expected: 2 tests pass, 0 fail.

- [ ] **Step 5: Run all existing tests**

Run: `npm test`

Expected: all prior tests plus the 2 retry tests pass.

- [ ] **Step 6: Commit the API helper**

```bash
git add index.js test/shiftWebhookIntegration.test.js
git commit -m "feat: fetch closed shifts with retry"
```

---

### Task 3: Route Closed-Shift Webhooks and Send One Deduplicated Alert

**Files:**
- Modify: `index.js` near imports, recent receipt cache, and webhook event routing
- Modify: `test/shiftWebhookIntegration.test.js`

**Interfaces:**
- Consumes: `detectShiftAnomalies`, `formatShiftAnomalyDiscord`, `fetchShiftByIdWithRetry`, and the existing `sendToDiscord(embed)`.
- Produces: `extractShiftId(payload): string | null`, `handleShiftCreated(payload): Promise<void>`, and one Discord send at most per shift ID within 24 hours.

- [ ] **Step 1: Add failing source-wiring and deduplication tests**

Append to `test/shiftWebhookIntegration.test.js`:

```js
test("webhook routes shifts.create through full-shift anomaly processing", () => {
  assert.match(source, /detectShiftAnomalies/);
  assert.match(source, /formatShiftAnomalyDiscord/);
  assert.match(source, /data\.type === "shifts\.create"/);
  assert.match(source, /await handleShiftCreated\(data\)/);
  assert.match(source, /await fetchShiftByIdWithRetry\(shiftId\)/);
  assert.match(source, /await sendToDiscord\(embed\)/);
});

test("shift alerts use a 24 hour recent-ID cache", () => {
  assert.match(source, /const processedShifts = new Map\(\)/);
  assert.match(source, /24 \* 60 \* 60 \* 1000/);
  assert.match(source, /Skipping duplicate shift webhook/);
});

test("extractShiftId accepts documented and defensive payload shapes", () => {
  const functionStart = source.indexOf("function extractShiftId");
  const functionEnd = source.indexOf("async function handleShiftCreated", functionStart);
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);
  const extractShiftId = vm.runInNewContext(
    `(${source.slice(functionStart, functionEnd).trim()})`
  );

  assert.equal(extractShiftId({ type: "shifts.create", data: { id: "nested" } }), "nested");
  assert.equal(extractShiftId({ type: "shifts.create", shift_id: "shift-id" }), "shift-id");
  assert.equal(extractShiftId({ type: "shifts.create", object_id: "object-id" }), "object-id");
  assert.equal(extractShiftId({ type: "shifts.create" }), null);
});

test("duplicate shift events fetch and send at most once", async () => {
  const functionStart = source.indexOf("function extractShiftId");
  const functionEnd = source.indexOf('app.post("/webhook/loyverse"', functionStart);
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);

  let fetchCount = 0;
  let sendCount = 0;
  const context = vm.createContext({
    processedShifts: new Map(),
    SHIFT_DEDUP_TTL_MS: 24 * 60 * 60 * 1000,
    console: { log() {}, error() {} },
    fetchShiftByIdWithRetry: async () => {
      fetchCount += 1;
      return { expected_cash: 100, actual_cash: 99, cash_movements: [] };
    },
    detectShiftAnomalies: () => ({ hasAnomaly: true }),
    formatShiftAnomalyDiscord: () => ({ title: "alert" }),
    sendToDiscord: async () => {
      sendCount += 1;
    },
  });
  const handlers = vm.runInContext(
    `(() => { ${source.slice(functionStart, functionEnd)}; return { handleShiftCreated }; })()`,
    context
  );

  const event = { type: "shifts.create", data: { id: "same-shift" } };
  await handlers.handleShiftCreated(event);
  await handlers.handleShiftCreated(event);

  assert.equal(fetchCount, 1);
  assert.equal(sendCount, 1);
});
```

- [ ] **Step 2: Run the integration tests and verify routing is absent**

Run: `node --test test/shiftWebhookIntegration.test.js`

Expected: retry tests pass; the four new tests fail because imports, routing, handlers, and recent-shift state are absent.

- [ ] **Step 3: Import the anomaly helpers and add the recent-shift cache**

Near the existing Pay Out helper imports in `index.js`, add:

```js
const {
  detectShiftAnomalies,
  formatShiftAnomalyDiscord,
} = require("./lib/shiftAnomalyAlerts");
```

Beside `processedReceipts`, add:

```js
const processedShifts = new Map();
const SHIFT_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
```

- [ ] **Step 4: Add shift-ID extraction and background handling**

Place these helpers before the webhook route so function declarations are easy to locate and test:

```js
function extractShiftId(payload) {
  if (!payload || typeof payload !== "object") return null;
  return (
    payload.shift_id ||
    payload.object_id ||
    (payload.data && (payload.data.id || payload.data.shift_id)) ||
    null
  );
}

async function handleShiftCreated(payload) {
  const shiftId = extractShiftId(payload);
  if (!shiftId) {
    console.error("Cannot process shifts.create webhook without a shift ID");
    return;
  }

  const now = Date.now();
  for (const [cachedId, timestamp] of processedShifts.entries()) {
    if (now - timestamp > SHIFT_DEDUP_TTL_MS) processedShifts.delete(cachedId);
  }

  if (processedShifts.has(shiftId)) {
    console.log(`Skipping duplicate shift webhook: ${shiftId}`);
    return;
  }

  processedShifts.set(shiftId, now);
  try {
    const shift = await fetchShiftByIdWithRetry(shiftId);
    const anomalies = detectShiftAnomalies(shift);
    const embed = formatShiftAnomalyDiscord(anomalies);
    if (embed) await sendToDiscord(embed);
  } catch (error) {
    processedShifts.delete(shiftId);
    console.error(`Error processing closed shift ${shiftId}:`, error.message);
  }
}
```

Deleting the cache entry on failure allows a later Loyverse retry to attempt processing again. Logs may contain the shift ID for diagnosis but must not contain tokens, webhook URLs, or employee fields.

- [ ] **Step 5: Route `shifts.create` before receipt and inventory heuristics**

At the top of the existing background event router, before `if (data.receipt_number || data.receipts)`, add:

```js
if (data.type === "shifts.create") {
  await handleShiftCreated(data);
  return;
}
```

This explicit branch prevents a shift payload from falling through to the generic notification while leaving receipt and inventory branches unchanged.

- [ ] **Step 6: Run the focused integration tests**

Run: `node --test test/shiftWebhookIntegration.test.js`

Expected: 6 tests pass, 0 fail.

- [ ] **Step 7: Run the full regression suite**

Run: `npm test`

Expected: all shift anomaly, retry, routing, existing Pay Out, daily report, and shift date tests pass with 0 failures.

- [ ] **Step 8: Perform syntax and secret-output checks**

Run:

```bash
node --check index.js
rg -n "opened_by_employee|closed_by_employee|employee_id" lib/shiftAnomalyAlerts.js
git diff --check
```

Expected: `node --check` exits 0, the employee-field search returns no matches, and `git diff --check` reports no whitespace errors.

- [ ] **Step 9: Commit webhook integration**

```bash
git add index.js test/shiftWebhookIntegration.test.js
git commit -m "feat: alert on closed shift anomalies"
```

---

### Task 4: Verify the Complete Feature Before Push

**Files:**
- Verify only: `index.js`, `lib/shiftAnomalyAlerts.js`, `test/shiftAnomalyAlerts.test.js`, `test/shiftWebhookIntegration.test.js`

**Interfaces:**
- Consumes: the completed tasks and approved design.
- Produces: evidence that the branch is safe to push; no new production behavior is added here.

- [ ] **Step 1: Run the complete automated test suite fresh**

Run: `npm test`

Expected: every test passes, 0 failures, 0 skipped, 0 cancelled.

- [ ] **Step 2: Verify syntax and repository cleanliness**

Run:

```bash
node --check index.js
node --check lib/shiftAnomalyAlerts.js
git diff --check
git status --short
```

Expected: both syntax checks and `git diff --check` exit 0. `git status --short` contains no uncommitted implementation files.

- [ ] **Step 3: Review commit scope**

Run: `git log --oneline --stat -4`

Expected: separate commits exist for the approved design, detector, retry helper, and webhook integration; no unrelated files appear.

- [ ] **Step 4: Push only after verification succeeds**

Run: `git push origin master`

Expected: the remote `master` advances to the verified local commit without force-push.
