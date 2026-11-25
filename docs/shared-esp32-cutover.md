# Shared ESP32 release handoff

**Registry-only rollout.** This candidate does not enable mandatory WebAuthn or change admin sign-in or proxy configuration. The Admin owner/caretaker SMS editor and Farmer read-only SMS presentation are unchanged.

The migration requires the already-deployed `sms_fishpens.owner_alert_phone` column. It adds the board registry and assignment ledger plus nullable telemetry/SMS attribution fields. It does not update existing records. Two rehearsals on an isolated restoration representing the deployed SMS schema preserved all original rows across 30 tables, including all 62 credential records. Normal startup only validates the schema.

## Physical acceptance

1. Connect the ESP32 with a USB data cable and put it and this Windows PC on the same private Wi-Fi. Verify the actual supported board/port and read the chip ID without resetting or uploading to the board.
2. Use the [isolated bench runbook](esp32-bench-test.md) with synthetic farmers A and B and its disposable key. Keep the existing wiring, use calibrated pH, temperature and NTU inputs, and match one sample on the LCD, Serial Monitor and dashboard. Record accepted telemetry IDs for both test fishpens. Unassign A, verify that uploads stop, then assign B without changing the bench key or flashing between assignments. Confirm old A readings stay with A. DO remains missing on this firmware; manual DO is still available.
3. Have the existing production sketch and hardware key available privately. Verify the board's chip ID against the historical credential record before adopting that record. Do not print the key, update its hash, or choose a record based on the dashboard count. Stop if the legacy record cannot be proven.

## Deploy the registry before flashing

- Apply only the reviewed additive migration. In Render, leave `PONDSENSE_ENABLE_SHARED_UPLOADS` unset (or set to `false`). Check that V2 returns `503` and legacy routes still require the same keys. Promote the matching Vercel deployment only after Render is healthy. Physical acceptance is not required for this phase.
- New boards may be registered and assigned, but their assignments are paused for telemetry. Legacy uploads continue under their original farmer and device. A legacy monitor cannot be adopted or reassigned through the registry while its protocol remains in service.

## Activate shared telemetry after physical acceptance

- After physical acceptance, note current Render and Vercel rollback targets and power off legacy senders. In an authorized maintenance window, explicitly set `PONDSENSE_ENABLE_SHARED_UPLOADS=true` and verify Render before turning on the board. This retires legacy ingestion. The emergency `PONDSENSE_PAUSE_HARDWARE_UPLOADS=true` blocks V2 without re-enabling V1.
- Adopt/assign the verified physical board and flash the V2 sketch with the production endpoint and existing key. There is one production firmware update, not one update per farmer transfer. Confirm a fresh accepted sample on the assigned farmer's dashboard without sending test SMS, then verify prior history and masked contacts. Keep the board off and stop if attribution or API compatibility fails.
