const { DateTime } = require("luxon");

const BANGKOK_ZONE = "Asia/Bangkok";
const NO_REASON = "ไม่ระบุเหตุผล";
const UNKNOWN_TIME = "ไม่ทราบเวลา";
const MAX_DISCORD_LINE_LENGTH = 3000;

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
  return entries.map((entry) => {
    const prefix = `- ${entry.time} — ฿${entry.amount.toFixed(2)} — `;
    const reason = String(entry.reason);
    const line = `${prefix}${reason}\n`;

    if (line.length <= MAX_DISCORD_LINE_LENGTH) return line;

    const availableReasonLength =
      MAX_DISCORD_LINE_LENGTH - prefix.length - "…\n".length;
    return `${prefix}${reason.slice(0, availableReasonLength)}…\n`;
  });
}

function escapeSheetCell(value) {
  return typeof value === "string" && /^[=+\-@]/.test(value)
    ? `'${value}`
    : value;
}

function buildPayOutSheetRows(entries) {
  return entries.map((entry) =>
    [entry.time, `${entry.amount.toFixed(2)} บาท`, entry.reason].map(
      escapeSheetCell
    )
  );
}

module.exports = {
  extractPayOutDetails,
  formatPayOutDiscordLines,
  buildPayOutSheetRows,
};
