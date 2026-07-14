# Pay Out Details in Daily Reports

## Goal

Show why cash was removed from the drawer in both the daily Discord report and the corresponding Google Sheets report. The report must preserve each Pay Out movement rather than only showing the aggregate amount.

## Scope

- Use `cash_movements` from the shifts already fetched for the requested daily report.
- Include movements whose `type` is `PAY_OUT`.
- Show the movement time, amount, and comment.
- Do not fetch or display employee names or employee IDs.
- Keep the existing aggregate Pay Out calculation based on `shift.paid_out`.
- Apply the feature only to daily reports. Monthly reports remain unchanged.

## Data Transformation

Introduce a small, independently testable formatter that receives the daily shifts and returns normalized Pay Out entries:

```text
{
  createdAt: ISO timestamp,
  time: Bangkok time in HH:mm format,
  amount: positive number,
  reason: comment or "ไม่ระบุเหตุผล"
}
```

The transformation will:

1. Read every shift's `cash_movements` array, treating a missing array as empty.
2. Select only movements with `type === "PAY_OUT"`.
3. Normalize `money_amount` to a positive numeric amount.
4. Replace a missing, empty, or whitespace-only comment with `ไม่ระบุเหตุผล`.
5. Sort entries by `created_at` in ascending order.
6. Format the displayed time in the `Asia/Bangkok` timezone.

## Discord Output

After the existing daily summary is sent, send a separate Discord summary titled `รายละเอียดนำเงินออก (Pay Out)` when at least one Pay Out entry exists.

Each line will use this shape:

```text
- 14:30 — ฿500.00 — ซื้อวัตถุดิบ
```

The existing Discord chunking mechanism will be reused so a day with many entries does not exceed Discord's description limit. No additional Discord message is sent when the day has no Pay Out entries.

## Google Sheets Output

In the daily sheet, add a section after the existing cash totals:

```text
รายละเอียดนำเงินออก (Pay Out)
เวลา | จำนวนเงิน | เหตุผล
14:30 | 500.00 บาท | ซื้อวัตถุดิบ
```

The section is omitted when there are no Pay Out entries. Existing product/category rows remain unchanged and continue after the new section.

## Error Handling

- A missing `cash_movements` array produces no entries and does not fail the report.
- An invalid or missing timestamp displays `ไม่ทราบเวลา` and sorts after valid timestamps.
- A non-numeric amount is treated as `0.00` so malformed upstream data cannot produce `NaN` in Discord or Sheets.
- Discord and Google Sheets retain their existing independent error handling; failure in one destination must not alter the normalized Pay Out data used by the other.

## Testing

Automated tests will cover:

- extracting multiple Pay Out entries across multiple shifts;
- excluding non-Pay-Out cash movements;
- sorting entries chronologically and formatting Bangkok time;
- replacing an empty comment with `ไม่ระบุเหตุผล`;
- handling missing movements, invalid timestamps, and non-numeric amounts;
- producing no Pay Out section when no entries exist;
- rendering the expected Discord lines and Google Sheets rows.

## Success Criteria

- The daily Discord report shows each Pay Out's time, amount, and reason without employee information.
- The daily Google Sheet contains the same Pay Out details.
- The aggregate Pay Out value remains unchanged and equals the sum supplied by shift totals.
- Existing daily sales, chart, and monthly reporting behavior continues to pass its tests.
