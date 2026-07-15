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
    `(() => { ${source.slice(
      start,
      end
    )}; return fetchShiftByIdWithRetry; })()`,
    context
  );
}

test("fetchShiftByIdWithRetry retries transient failures and returns the full shift", async () => {
  let attempts = 0;
  const axiosClient = {
    async get(url, config) {
      attempts += 1;
      assert.equal(
        url,
        "https://api.loyverse.com/v1.0/shifts/shift-1"
      );
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
    fetchShift("missing", {
      axiosClient,
      sleep: async () => {},
    }),
    /missing/
  );
  assert.equal(attempts, 1);
});
