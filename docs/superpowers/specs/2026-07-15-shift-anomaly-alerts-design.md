# Shift Anomaly Alerts

## Goal

Send one Discord alert immediately after a Loyverse shift closes when the shift contains a cash discrepancy, a high-value Pay Out, or a Pay Out without a reason. Alerts must not display employee names or identifiers.

## Trigger and Data Flow

1. Loyverse sends a `shifts.create` event to the existing webhook after a shift closes.
2. The webhook acknowledges the request immediately, as it does for current events.
3. Background processing extracts the shift ID from the event and fetches the complete shift from `GET /v1.0/shifts/{shift_id}`.
4. A pure anomaly detector evaluates the completed shift.
5. If at least one rule matches, the service sends one combined Discord embed. If no rule matches, it sends nothing.

Fetching the complete shift is required because the webhook event may contain only an object identifier, while the alert rules need the final cash totals and individual cash movements.

## Alert Rules

The detector applies these rules independently:

- **Cash discrepancy:** alert when the absolute difference between `actual_cash` and `expected_cash` is at least 1 baht. The alert indicates whether cash is over or short and shows the signed difference.
- **High-value Pay Out:** alert for each `PAY_OUT` cash movement whose absolute amount is strictly greater than 1,000 baht. An amount of exactly 1,000 baht does not alert.
- **Missing Pay Out reason:** alert for each `PAY_OUT` movement whose comment is missing, blank, or whitespace-only.

A single Pay Out can match both the high-value and missing-reason rules. It appears once in the message with both warning labels.

Non-numeric cash values are normalized safely and do not produce `NaN`. Movement times are displayed in the `Asia/Bangkok` timezone.

## Discord Message

One red/orange Discord embed is sent per anomalous shift with:

- title indicating a cash anomaly after shift close;
- cash discrepancy summary when applicable;
- a list of anomalous Pay Out movements showing time, amount, reason, and matched warnings;
- the shift closing timestamp.

The message excludes employee names and employee IDs. It also excludes the shift ID from user-facing text; the ID is retained only for deduplication and logs.

## Duplicate Prevention

The service keeps a bounded in-memory cache of recently processed shift IDs, following the existing receipt deduplication pattern. A duplicate webhook for the same shift is acknowledged but does not send another Discord alert. Cache entries expire after 24 hours.

This prevents common webhook retries from duplicating alerts. Persistence across a Render restart is outside this change; the daily report remains the historical source of truth.

## Error Handling

- The webhook response is returned before API fetching and Discord delivery so Loyverse is not blocked.
- Fetching a shift retries transient network failures up to three times with short backoff.
- A missing shift ID is logged and ignored without sending a misleading alert.
- API or Discord failures are logged with the shift ID but without exposing access tokens or webhook secrets.
- Existing receipt and inventory webhook behavior remains unchanged.

## Components

Create a focused CommonJS module for shift alert behavior:

- `detectShiftAnomalies(shift, options)` returns normalized discrepancy and Pay Out anomalies.
- `formatShiftAnomalyDiscord(anomalies)` returns the Discord embed content without sending it.

Keep `index.js` responsible for webhook routing, fetching the full shift, deduplication, and Discord delivery. Thresholds are defined as named configuration values with defaults of 1 baht for discrepancy and 1,000 baht for a high Pay Out.

## Testing

Unit tests cover:

- discrepancy of 0.99 baht does not alert and 1 baht does;
- both cash shortage and cash overage formatting;
- Pay Out of exactly 1,000 baht does not alert and 1,000.01 baht does;
- blank and whitespace-only reasons alert;
- one movement matching two rules appears once with both warnings;
- employee fields never appear in formatted output;
- malformed numeric values do not produce `NaN`;
- normal shifts produce no Discord output;
- duplicate shift events send at most one alert;
- webhook shift events fetch the full shift and preserve existing event routing.

## Acceptance Criteria

- An anomalous shift produces one Discord alert shortly after the shift closes.
- A normal shift produces no anomaly alert.
- Cash discrepancies alert from 1 baht upward.
- Individual Pay Outs alert only when greater than 1,000 baht.
- Pay Outs without a reason alert regardless of amount.
- No employee name or identifier appears in the Discord alert.
- Duplicate webhook delivery does not duplicate the alert during the 24-hour cache window.
- Existing daily reports, Pay Out details, receipt notifications, and inventory notifications continue to pass their tests.
