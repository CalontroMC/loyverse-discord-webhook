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
        {
          type: "PAY_OUT",
          money_amount: 1000,
          comment: "ซื้อของ",
          created_at: "2026-07-15T08:00:00Z",
        },
        {
          type: "PAY_OUT",
          money_amount: 1000.01,
          comment: "ซื้อของเพิ่ม",
          created_at: "2026-07-15T09:00:00Z",
        },
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
        {
          type: "PAY_OUT",
          money_amount: 50,
          comment: "   ",
          created_at: "2026-07-15T08:00:00Z",
        },
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
        {
          type: "PAY_OUT",
          money_amount: -1500,
          comment: null,
          created_at: "2026-07-15T08:00:00Z",
        },
      ],
    })
  );

  assert.equal(result.payOuts.length, 1);
  assert.equal(result.payOuts[0].amount, 1500);
  assert.deepEqual(result.payOuts[0].warnings, [
    "HIGH_AMOUNT",
    "MISSING_REASON",
  ]);
});

test("formats Bangkok time and excludes employee and shift identifiers", () => {
  const anomalies = detectShiftAnomalies(
    shift({
      actual_cash: 998,
      cash_movements: [
        {
          type: "PAY_OUT",
          money_amount: 1200,
          comment: "ค่าของ",
          employee_id: "employee-movement-secret",
          created_at: "2026-07-15T01:30:00Z",
        },
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

test("does not report a cash discrepancy when either cash total is malformed", () => {
  const malformedExpected = detectShiftAnomalies(
    shift({ expected_cash: "bad", actual_cash: 1000 })
  );
  const malformedActual = detectShiftAnomalies(
    shift({ expected_cash: 1000, actual_cash: "bad" })
  );

  assert.equal(malformedExpected.discrepancy, null);
  assert.equal(malformedExpected.hasAnomaly, false);
  assert.equal(malformedActual.discrepancy, null);
  assert.equal(malformedActual.hasAnomaly, false);
});

test("bounds a large anomaly description to Discord's embed limit", () => {
  const cash_movements = Array.from({ length: 200 }, (_, index) => ({
    type: "PAY_OUT",
    money_amount: 1001 + index,
    comment: `เหตุผล-${index}-${"ย".repeat(100)}`,
    created_at: "2026-07-15T01:30:00Z",
  }));
  const embed = formatShiftAnomalyDiscord(
    detectShiftAnomalies(shift({ cash_movements }))
  );

  assert.ok(embed.description.length <= 4096);
  assert.match(embed.description, /และอีก \d+ รายการ/);
});
