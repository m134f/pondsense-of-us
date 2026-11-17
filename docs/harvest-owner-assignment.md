# Simplified Harvest Management and owner assignments

## Data changes

Run normal backend startup migrations after a backup. migrateOwnerFishpen runs after SMS fishpen migrations and adds owner_fishpen_assignments (one owner, one existing sms_fishpens record) and nullable harvest_batches.fishpen_id. It only auto-assigns owners with exactly one existing fishpen configuration. Multiple/ambiguous fishpens require an explicit administrator choice. No historical batch labels, monitor links, readings, SMS logs or counts are rewritten. Existing batches retain NULL fishpen_id and remain owned by their original farmer.

Administrator Settings contains Owner fishpen assignments. Select an owner, select an existing configuration or create a fishpen, name it and optionally choose an active device already owned by that farmer. Foreign fishpens/devices are rejected; changes are audited. Existing historical SMS configurations are retained but farmer contact editing is limited to the assigned configuration. Names/device mapping are administrator-managed. Assignment foreign keys intentionally prevent deleting assigned records without resolving their assignments first.

## Harvest security

The shared /api/harvests guard applies before all harvest and planning-review handlers. It requires a farmer token, resolves assignment from the database, and checks batch ownership independently of submitted owner/fishpen fields. GET history remains available to unassigned owners; mutations require a valid assignment. New groups are created in a transaction with the assignment locked, taking fishpen identity and device from the server. Frontend fishpen IDs/names/monitor IDs are not used to choose a group assignment. Linked historical groups for a different assignment are read-only; legacy NULL-linked groups preserve historical names/device links on edit. Every existing write still uses owner-scoped queries and stock-count checks.

## UI

HarvestWorkspace is the farmer-only presentation component; existing API handlers and count calculations remain in place. Overview shows four summaries and four plain-language actions. Group details and history preserve all event lists, water review/observations, charts, editing/deletion, completed records, filters and CSV. Required fields appear first; optional weight targets, prices, counts, notes and reminders are in expandable sections. No harvest or growth predictions are added. Missing optional harvest counts do not reduce remaining stock by an invented count.

## Verification

Automated mocked HTTP tests exercise unauthenticated/nonfarmer denial, unassigned creation denial, cross-owner group denial, forged fishpen/owner fields, history access and additive migration conditions. Pure tests cover remaining stock and reminders. Browser checks use mocked APIs across 320/360/375/390/430/768/1440 widths, required-first forms, three recording actions, history access, English/Filipino and missing assignments. These do not replace a real MySQL migration test, concurrent assignment/reassignment testing, real SMS or production user acceptance testing. No real SMS is sent.

Deployment is separate: verify all current owners' assignments before relying on new harvest mutations, especially owners with multiple auto-created ESP32/SMS configurations. Do not run the full seed schema as a migration.
