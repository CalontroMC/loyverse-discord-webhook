const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadFetchAllShifts(fakeAxios) {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const start = source.indexOf("async function fetchAllShifts");
  const end = source.indexOf("async function fetchAllCategories", start);

  assert.notEqual(start, -1, "fetchAllShifts must exist");
  assert.notEqual(end, -1, "fetchAllShifts boundary must exist");

  const context = vm.createContext({
    axios: fakeAxios,
    LOYVERSE_ACCESS_TOKEN: "test-token",
  });
  return vm.runInContext(`(${source.slice(start, end).trim()})`, context);
}

test("fetchAllShifts excludes shifts opened outside the requested day", async () => {
  const fakeAxios = {
    async get() {
      return {
        data: {
          shifts: [
            {
              id: "target-day",
              opened_at: "2026-07-12T10:00:00.000Z",
              paid_in: 2301,
              paid_out: 291,
            },
            {
              id: "older-shift",
              opened_at: "2026-06-01T10:00:00.000Z",
              paid_in: 3467,
              paid_out: 31789.5,
            },
          ],
        },
      };
    },
  };
  const fetchAllShifts = loadFetchAllShifts(fakeAxios);

  const shifts = await fetchAllShifts(
    "2026-07-11T17:00:00.000Z",
    "2026-07-12T16:59:59.999Z"
  );

  assert.deepEqual(
    Array.from(shifts, (shift) => shift.id),
    ["target-day"]
  );
});
