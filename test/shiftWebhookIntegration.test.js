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
  const functionEnd = source.indexOf(
    "async function handleShiftCreated",
    functionStart
  );

  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);

  const extractShiftId = vm.runInNewContext(
    `(${source.slice(functionStart, functionEnd).trim()})`
  );

  assert.equal(
    extractShiftId({ type: "shifts.create", data: { id: "nested" } }),
    "nested"
  );
  assert.equal(
    extractShiftId({ type: "shifts.create", shift_id: "shift-id" }),
    "shift-id"
  );
  assert.equal(
    extractShiftId({ type: "shifts.create", object_id: "object-id" }),
    "object-id"
  );
  assert.equal(extractShiftId({ type: "shifts.create" }), null);
});

test("duplicate shift events fetch and send at most once", async () => {
  const functionStart = source.indexOf("function extractShiftId");
  const functionEnd = source.indexOf(
    'app.post("/webhook/loyverse"',
    functionStart
  );

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
      return {
        expected_cash: 100,
        actual_cash: 99,
        cash_movements: [],
      };
    },
    detectShiftAnomalies: () => ({ hasAnomaly: true }),
    formatShiftAnomalyDiscord: () => ({ title: "alert" }),
    sendToDiscord: async () => {
      sendCount += 1;
    },
  });
  const handlers = vm.runInContext(
    `(() => { ${source.slice(
      functionStart,
      functionEnd
    )}; return { handleShiftCreated }; })()`,
    context
  );

  const event = { type: "shifts.create", data: { id: "same-shift" } };
  await handlers.handleShiftCreated(event);
  await handlers.handleShiftCreated(event);

  assert.equal(fetchCount, 1);
  assert.equal(sendCount, 1);
});
