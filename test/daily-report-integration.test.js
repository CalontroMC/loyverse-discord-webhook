const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

test("daily report wires normalized Pay Out details to Discord and Sheets", () => {
  assert.match(source, /extractPayOutDetails\(shifts\)/);
  assert.match(source, /formatPayOutDiscordLines\(payOutDetails\)/);
  assert.match(source, /payOutDetails,\s*\}\);/);
  assert.match(
    source,
    /buildPayOutSheetRows\(summaryData\.payOutDetails \|\| \[\]\)/
  );
  assert.match(source, /รายละเอียดนำเงินออก \(Pay Out\)/);
});
