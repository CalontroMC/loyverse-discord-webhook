# Pay Out Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-movement Pay Out time, amount, and reason to daily Discord and Google Sheets reports without displaying employee information.

**Architecture:** Add a focused CommonJS module that normalizes Loyverse `cash_movements` and renders destination-specific lines/rows. Keep `index.js` responsible only for orchestration: extract once from the already-filtered daily shifts, send a separate Discord section, and pass the same normalized entries to the Sheets writer.

**Tech Stack:** Node.js CommonJS, Node built-in test runner, Luxon, Discord webhooks, `google-spreadsheet`.

## Global Constraints

- Include only movements whose `type` is exactly `PAY_OUT`.
- Display time in `Asia/Bangkok` using `HH:mm`.
- Display amount as a positive number with two decimal places.
- Display `ไม่ระบุเหตุผล` for a blank comment and `ไม่ทราบเวลา` for an invalid timestamp.
- Do not fetch or display employee names or employee IDs.
- Keep aggregate Pay Out based on `shift.paid_out`; do not recompute it from movements.
- Do not change monthly reporting.

---

## File Structure

- Create `lib/payOutDetails.js`: pure normalization and destination formatting functions.
- Create `test/payOutDetails.test.js`: behavior tests for the pure module.
- Create `test/daily-report-integration.test.js`: source-level wiring regression test for the existing monolithic entrypoint.
- Modify `index.js`: import helpers, add three-column Sheets support, send Discord detail section, and pass normalized entries to Sheets.

### Task 1: Normalize and Format Pay Out Movements

**Files:**
- Create: `lib/payOutDetails.js`
- Test: `test/payOutDetails.test.js`

**Interfaces:**
- Consumes: `extractPayOutDetails(shifts: Array<object>): Array<PayOutDetail>` where each shift may contain `cash_movements`.
- Produces: `PayOutDetail = { createdAt: string|null, time: string, amount: number, reason: string }`.
- Produces: `formatPayOutDiscordLines(entries): string[]`.
- Produces: `buildPayOutSheetRows(entries): Array<[string,string,string]>`.

- [ ] **Step 1: Write failing normalization and formatting tests**

Create `test/payOutDetails.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  extractPayOutDetails,
  formatPayOutDiscordLines,
  buildPayOutSheetRows,
} = require("../lib/payOutDetails");

test("extracts only Pay Out movements and sorts them in Bangkok time", () => {
  const shifts = [
    {
      cash_movements: [
        {
          type: "PAY_OUT",
          money_amount: -500,
          comment: "ซื้อวัตถุดิบ",
          created_at: "2026-07-14T08:30:00.000Z",
        },
        {
          type: "PAY_IN",
          money_amount: 100,
          comment: "เงินทอน",
          created_at: "2026-07-14T07:00:00.000Z",
        },
      ],
    },
    {
      cash_movements: [
        {
          type: "PAY_OUT",
          money_amount: "200",
          comment: "  ",
          created_at: "2026-07-14T06:00:00.000Z",
        },
      ],
    },
    {},
  ];

  assert.deepEqual(extractPayOutDetails(shifts), [
    {
      createdAt: "2026-07-14T06:00:00.000Z",
      time: "13:00",
      amount: 200,
      reason: "ไม่ระบุเหตุผล",
    },
    {
      createdAt: "2026-07-14T08:30:00.000Z",
      time: "15:30",
      amount: 500,
      reason: "ซื้อวัตถุดิบ",
    },
  ]);
});

test("handles malformed Pay Out values without producing NaN", () => {
  const entries = extractPayOutDetails([
    {
      cash_movements: [
        {
          type: "PAY_OUT",
          money_amount: "invalid",
          created_at: "invalid",
        },
      ],
    },
  ]);

  assert.deepEqual(entries, [
    {
      createdAt: null,
      time: "ไม่ทราบเวลา",
      amount: 0,
      reason: "ไม่ระบุเหตุผล",
    },
  ]);
});

test("renders Discord lines and three-column Sheets rows", () => {
  const entries = [
    {
      createdAt: "2026-07-14T08:30:00.000Z",
      time: "15:30",
      amount: 500,
      reason: "ซื้อวัตถุดิบ",
    },
  ];

  assert.deepEqual(formatPayOutDiscordLines(entries), [
    "- 15:30 — ฿500.00 — ซื้อวัตถุดิบ\n",
  ]);
  assert.deepEqual(buildPayOutSheetRows(entries), [
    ["15:30", "500.00 บาท", "ซื้อวัตถุดิบ"],
  ]);
});

test("returns empty destination output when there are no Pay Outs", () => {
  assert.deepEqual(extractPayOutDetails([]), []);
  assert.deepEqual(formatPayOutDiscordLines([]), []);
  assert.deepEqual(buildPayOutSheetRows([]), []);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/payOutDetails.test.js`

Expected: FAIL with `Cannot find module '../lib/payOutDetails'`.

- [ ] **Step 3: Implement the pure Pay Out module**

Create `lib/payOutDetails.js`:

```js
const { DateTime } = require("luxon");

const BANGKOK_ZONE = "Asia/Bangkok";
const NO_REASON = "ไม่ระบุเหตุผล";
const UNKNOWN_TIME = "ไม่ทราบเวลา";

function normalizeAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.abs(amount) : 0;
}

function normalizeMovement(movement) {
  const parsedTime = DateTime.fromISO(movement.created_at || "", {
    setZone: true,
  });
  const hasValidTime = parsedTime.isValid;
  const reason =
    typeof movement.comment === "string" && movement.comment.trim()
      ? movement.comment.trim()
      : NO_REASON;

  return {
    createdAt: hasValidTime ? movement.created_at : null,
    time: hasValidTime
      ? parsedTime.setZone(BANGKOK_ZONE).toFormat("HH:mm")
      : UNKNOWN_TIME,
    amount: normalizeAmount(movement.money_amount),
    reason,
  };
}

function extractPayOutDetails(shifts) {
  return (Array.isArray(shifts) ? shifts : [])
    .flatMap((shift) =>
      Array.isArray(shift.cash_movements) ? shift.cash_movements : []
    )
    .filter((movement) => movement && movement.type === "PAY_OUT")
    .map(normalizeMovement)
    .sort((a, b) => {
      if (a.createdAt === null) return b.createdAt === null ? 0 : 1;
      if (b.createdAt === null) return -1;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });
}

function formatPayOutDiscordLines(entries) {
  return entries.map(
    (entry) =>
      `- ${entry.time} — ฿${entry.amount.toFixed(2)} — ${entry.reason}\n`
  );
}

function buildPayOutSheetRows(entries) {
  return entries.map((entry) => [
    entry.time,
    `${entry.amount.toFixed(2)} บาท`,
    entry.reason,
  ]);
}

module.exports = {
  extractPayOutDetails,
  formatPayOutDiscordLines,
  buildPayOutSheetRows,
};
```

- [ ] **Step 4: Run the focused and full tests and verify GREEN**

Run these commands in order:

```powershell
node --test test/payOutDetails.test.js
npm test
```

Expected: all tests PASS with zero failures.

- [ ] **Step 5: Commit the pure module**

```bash
git add lib/payOutDetails.js test/payOutDetails.test.js
git commit -m "feat: format Pay Out movement details"
```

### Task 2: Wire Pay Out Details into Daily Discord and Sheets Reports

**Files:**
- Modify: `index.js:1-10`
- Modify: `index.js:279-350`
- Modify: `index.js:744-960`
- Create: `test/daily-report-integration.test.js`

**Interfaces:**
- Consumes: `extractPayOutDetails`, `formatPayOutDiscordLines`, and `buildPayOutSheetRows` from Task 1.
- Produces: daily Discord detail messages and daily Sheets rows sourced from the same `payOutDetails` array.

- [ ] **Step 1: Write a failing wiring regression test**

Create `test/daily-report-integration.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

test("daily report wires normalized Pay Out details to Discord and Sheets", () => {
  assert.match(source, /extractPayOutDetails\(shifts\)/);
  assert.match(source, /formatPayOutDiscordLines\(payOutDetails\)/);
  assert.match(source, /payOutDetails,\s*\}\);/);
  assert.match(source, /buildPayOutSheetRows\(summaryData\.payOutDetails \|\| \[\]\)/);
  assert.match(source, /รายละเอียดนำเงินออก \(Pay Out\)/);
});
```

- [ ] **Step 2: Run the wiring test and verify RED**

Run: `node --test test/daily-report-integration.test.js`

Expected: FAIL because `index.js` does not yet call `extractPayOutDetails(shifts)`.

- [ ] **Step 3: Import the Pay Out helpers**

Add after the Luxon import in `index.js`:

```js
const {
  extractPayOutDetails,
  formatPayOutDiscordLines,
  buildPayOutSheetRows,
} = require("./lib/payOutDetails");
```

- [ ] **Step 4: Expand the daily sheet to three columns and append Pay Out rows**

In `appendDailySummaryToGoogleSheet`, use this header for both new and existing sheets:

```js
const sheetHeaders = ["หัวข้อ", "ข้อมูล", "เหตุผล"];
```

Pass `headerValues: sheetHeaders` to `doc.addSheet` and pass `sheetHeaders` to `sheet.setHeaderRow`.

After the existing cash totals and before the category section, add:

```js
const payOutRows = buildPayOutSheetRows(summaryData.payOutDetails || []);
if (payOutRows.length > 0) {
  rowsToAdd.push(
    ["", "", ""],
    ["รายละเอียดนำเงินออก (Pay Out)", "", ""],
    ["เวลา", "จำนวนเงิน", "เหตุผล"],
    ...payOutRows
  );
}

rowsToAdd.push(
  ["", "", ""],
  ["ยอดขายแยกตามหมวดหมู่", "", ""]
);
```

Remove the old category separator and category heading from the initial `rowsToAdd` literal so they are not duplicated.

- [ ] **Step 5: Extract once and send a separate Discord detail section**

Immediately after `const shifts = await fetchAllShifts(...)` in `sendDailySummary`, add:

```js
const payOutDetails = extractPayOutDetails(shifts);
```

Immediately after the existing daily `sendSummaryToDiscord(...)` call, add:

```js
if (payOutDetails.length > 0) {
  await sendSummaryToDiscord(
    "รายละเอียดนำเงินออก (Pay Out)",
    0xe67e22,
    "**รายการนำเงินออกประจำวัน:**",
    formatPayOutDiscordLines(payOutDetails),
    []
  );
}
```

Add `payOutDetails` to the object passed to `appendDailySummaryToGoogleSheet`:

```js
await appendDailySummaryToGoogleSheet({
  dateStr: targetDate.toFormat("yyyy-MM-dd"),
  totalRevenue,
  totalReceipts,
  totalItemsSold,
  totalOpeningCash,
  totalPayIns,
  totalPayOuts,
  totalExpectedCash,
  totalActualCash,
  difference: totalActualCash - totalExpectedCash,
  groupedItems,
  allItemsArray,
  payOutDetails,
});
```

- [ ] **Step 6: Run focused tests and fix only wiring defects**

Run: `node --test test/daily-report-integration.test.js test/payOutDetails.test.js`

Expected: both test files PASS with zero failures.

- [ ] **Step 7: Run the complete verification suite**

Run:

```bash
npm test
node --check index.js
git diff --check
```

Expected: all tests PASS; syntax check and diff check exit with code 0.

- [ ] **Step 8: Commit the report integration**

```bash
git add index.js test/daily-report-integration.test.js
git commit -m "feat: show Pay Out reasons in daily reports"
```

- [ ] **Step 9: Review the final branch scope**

Run:

```bash
git status -sb
git diff master...HEAD --stat
git log --oneline master..HEAD
```

Expected: a clean feature branch containing the design commit and the two implementation commits, with changes limited to the design/plan documents, `lib/payOutDetails.js`, its tests, and `index.js`.
