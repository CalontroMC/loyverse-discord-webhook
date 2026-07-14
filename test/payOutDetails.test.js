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

test("escapes formula-like reasons only in Sheets rows", () => {
  const entries = ["=SUM(A1:A2)", "+cmd", "-10", "@mention"].map(
    (reason) => ({
      createdAt: "2026-07-14T08:30:00.000Z",
      time: "15:30",
      amount: 500,
      reason,
    })
  );

  assert.deepEqual(
    buildPayOutSheetRows(entries).map((row) => row[2]),
    ["'=SUM(A1:A2)", "'+cmd", "'-10", "'@mention"]
  );
  assert.deepEqual(
    formatPayOutDiscordLines(entries).map((line) =>
      line.slice(line.lastIndexOf(" — ") + 3, -1)
    ),
    entries.map((entry) => entry.reason)
  );
});

test("bounds Discord lines by truncating only an oversized reason", () => {
  const fixedPrefix = "- 15:30 — ฿500.00 — ";
  const [line] = formatPayOutDiscordLines([
    {
      createdAt: "2026-07-14T08:30:00.000Z",
      time: "15:30",
      amount: 500,
      reason: "ก".repeat(4000),
    },
  ]);

  assert.ok(line.length <= 3000);
  assert.ok(line.startsWith(fixedPrefix));
  assert.ok(line.endsWith("…\n"));
});

test("returns empty destination output when there are no Pay Outs", () => {
  assert.deepEqual(extractPayOutDetails([]), []);
  assert.deepEqual(formatPayOutDiscordLines([]), []);
  assert.deepEqual(buildPayOutSheetRows([]), []);
});
