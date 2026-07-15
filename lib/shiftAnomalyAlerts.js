const { DateTime } = require("luxon");

const BANGKOK_ZONE = "Asia/Bangkok";
const DEFAULT_DISCREPANCY_THRESHOLD = 1;
const DEFAULT_HIGH_PAY_OUT_THRESHOLD = 1000;
const MAX_DISCORD_DESCRIPTION_LENGTH = 4096;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
  const actualCash = optionalFiniteNumber(shift.actual_cash);
  const expectedCash = optionalFiniteNumber(shift.expected_cash);
  const hasValidCashTotals = actualCash !== null && expectedCash !== null;
  const difference = hasValidCashTotals ? actualCash - expectedCash : 0;
  const discrepancy =
    hasValidCashTotals && Math.abs(difference) >= discrepancyThreshold
      ? {
          amount: difference,
          direction: difference < 0 ? "SHORT" : "OVER",
        }
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
    for (let index = 0; index < anomalies.payOuts.length; index += 1) {
      const movement = anomalies.payOuts[index];
      const warningLabels = movement.warnings.map((warning) =>
        warning === "HIGH_AMOUNT" ? "ยอดเกิน ฿1,000" : "ไม่ระบุเหตุผล"
      );
      const movementLine = `- ${movement.time} — ฿${movement.amount.toFixed(
        2
      )} — ${movement.reason} (${warningLabels.join(", ")})`;
      const remainingAfter = anomalies.payOuts.length - index - 1;
      const reservedOverflow = remainingAfter
        ? `\n- … และอีก ${remainingAfter} รายการ`
        : "";
      const candidate = `${lines.join("\n")}\n${movementLine}${reservedOverflow}`;

      if (candidate.length <= MAX_DISCORD_DESCRIPTION_LENGTH) {
        lines.push(movementLine);
        continue;
      }

      lines.push(`- … และอีก ${anomalies.payOuts.length - index} รายการ`);
      break;
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
