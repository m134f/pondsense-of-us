# Recommendations and Harvest Planning Checkpoint

Resumed and verified on 2026-11-08 after the earlier pause. Changes are saved locally, uncommitted, and NOT deployed. Do not revert existing changes or reset any database.

## Request

Original requirements: `C:\Users\New\.codex\attachments\ab024e18-56ae-4c89-ba00-5ff111c09376\Pasted text.txt`.
Improve existing recommendations and harvest planning without rebuilding monitoring, authentication, SMS, or fish suitability.

## Completed Changes

- Rule-based, bilingual recommendations distinguish safe, warning, critical, missing, unavailable, stale, and unverified readings. Missing values do not become zero or safe.
- Highest-priority dashboard advice, expandable explanations and additional parameters, filtered recommendation history, and acknowledgement. Polling does not create duplicate history.
- Per-batch device assignment and water context, manual water-test records, observation log, sampling notes and recorded-weight chart.
- Farmer-selected harvest schedules, countdown stages, recent mortality, remaining-stock estimates, partial harvests, explicitly confirmed completion, recent harvests, gross sales and CSV handling.
- Owner-scoped APIs and transactional stock checks; active-batch checks for observations/manual measurements use completion locks.
- Reminder eligibility for 7 days, 1 day, target date and overdue; persistent deduplication and shared daily SMS ledger. Failed attempts are not marked sent. Admin planning-SMS audit view.
- Existing full five-parameter scoring weights remain unchanged. Manual analysis asks for confirmation of actual measurements. Unverified sensor estimates cannot produce the existing turbidity ranking.
- Invalid or incomplete configured species ranges explicitly fall back to application reference ranges instead of converting null to zero.
- A successfully saved batch measurement remains successful if secondary advice archival fails; the UI warns against resubmission.
- Batch reviews show latest measurement time and an explicit notice when current verified water conditions are unavailable. Recommendation history explains its per-submission scope.

## Files

Modified: `server/index.ts`, `src/App.tsx`, `src/lib/harvest.ts`.
Added: `server/migrations/planning.ts`, `server/routes/planning.ts`, `server/services/PlanningService.ts`, `server/services/PlanningSms.ts`, `server/planning.integration.test.ts`, `src/components/RecommendedActions.tsx`, `src/components/HarvestReview.tsx`, `src/lib/api.ts`, `src/lib/recommendations.ts`, `src/lib/recommendations.test.ts`.
The preexisting untracked `tmp/` directory was left alone.

## Database

Additive startup migration adds batch notes/device assignment, sample/harvest-event notes, and tables `harvest_observations`, `batch_water_measurements`, `recommendation_history`, `planning_sms_log`. Existing batch/history records are not reset. Test migration was run repeatedly successfully. No production/cloud migration was run. Back up production and review migration before deployment.

## Verified at Checkpoint

- `npm run build`: PASS (TypeScript and Vite), rerun November 8. Large bundle warning remains: 723.11 kB minified JavaScript, 214.32 kB gzip.
- `$env:RUN_PLANNING_DB_TESTS='1'; node --import tsx --test src/lib/harvest.test.ts src/lib/recommendations.test.ts server/planning.integration.test.ts`: 18 PASS, zero failures/skips, after final edits. Initial retry failed because the isolated database was stopped; tests passed after starting it.
- Integration tests use only an isolated local MariaDB at 127.0.0.1:3307, never configured application/Aiven data. Covered migration preservation, owner isolation, simultaneous temperature/turbidity/pH payload storage, missing/stale readings, fishpen separation, history deduplication/filter/ack, manual validation, observations, sampling, mortality, partial/complete harvests, concurrent stock guards, gross sales, and mocked SMS concurrency/failure/reminder deduplication.
- Browser checks using headless Edge/Playwright: login, add/edit batch, sampling, mortality, partial harvest (remaining 75), confirmed complete harvest (remaining 0, prior events/sample preserved), CSV download, manual DO measurement, observation submission, recommendation acknowledgement and fishpen filter, English/Filipino switching. No JavaScript page errors were observed.
- Responsive checks: desktop 1440px, harvest at 390px and 320px, dashboard at 390px. Document width matched viewport after charts resized. This is browser emulation, not a physical iPhone test.
- No real SMS was sent. No physical hardware, deployed-site, or MySQL 8.4 acceptance test was completed.

## Remaining Work

1. The older `/api/v1/sensors/data` endpoint retains its existing analysis/history/SMS behavior but is not connected to the new recommendation archive. The new `/api/v1/sensors/measurements` path is covered. Verify deployed firmware uses the intended endpoint before rollout.
2. Recommendation history intentionally represents individual submissions. A single-parameter manual submission archives missing states for parameters not included; the current batch review merges available measurements. The UI now explains this distinction.
3. The rule engine supports explicit sensor-unavailable state, but telemetry without a persisted disconnection flag can only be displayed as missing/stale. Verify firmware and calibrated measurements physically.
4. Daily SMS protection reserves one attempt per farmer/day. Failed attempts remain failed and do not automatically retry that day. Provider acceptance does not prove handset delivery. Review retry policy before production use.
5. Validate migration/API behavior on a staging copy of MySQL 8.4. Local tests used MariaDB. Confirm threshold guidance with an aquaculture expert; no validated biological growth/yield model is included.
6. Complete real farmer usability testing, physical iPhone testing, actual sensor/ownership/reconnection tests, SMS delivery tests, and a production deployment smoke test.

## Rollout

1. Back up the production database, review the additive migration and test it against a staging copy. Do not re-import schema.sql or reset existing data.
2. Review all modified and added files listed above. Commit them together only after approval; do not add secrets, test databases or the preexisting tmp directory.
3. Deploy the backend first. Its startup applies migratePlanning after existing harvest storage initialization. Verify health, auth, owner isolation and existing records before deploying the frontend.
4. Deploy the frontend and smoke-test manual/sensor advice, fishpen assignment, batch forms and export. Validate real SMS separately with explicit consent and credits.
5. Preserve schema/data if rolling back application code. No destructive downgrade migration is provided.

## Temporary Infrastructure

Temporary MariaDB data/config: `C:\Users\New\AppData\Local\Temp\pondsense-planning-test-20261106` (not XAMPP's real data directory). November 8 databases retained: `pondsense_planning_test_1794123650292` (browser QA) and `pondsense_planning_test_1794124428604` (final automated run). Earlier test databases remain untouched.

Browser QA used localhost:5174, API:5001, and isolated MariaDB:3307. All foreground QA services and the controlled browser were stopped after verification. A detached preview restart was blocked by the execution policy, so no persistent preview is claimed. Production and real XAMPP databases were not used or modified by these tests. Do not delete retained test data or stop unrelated user services.
