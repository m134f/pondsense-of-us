import type { Pool, RowDataPacket } from 'mysql2/promise';

const requiredColumns = {
  users: 'id full_name username phone email password_hash role created_at account_status auth_version must_change_password temporary_password_expires_at password_changed_at',
  water_readings: 'id user_id recorded_at input_mode ph temperature turbidity ammonia dissolved_oxygen best_fish best_score confidence status',
  alerts: 'id reading_id user_id alert_type message severity sms_sent sms_status sms_error sent_at',
  corrective_action_log: 'id reading_id user_id action_taken result_notes logged_at',
  fish_species: 'id name is_active scientific_name optimal_ph_min optimal_ph_max optimal_temp_min optimal_temp_max optimal_do_min optimal_do_max optimal_turb_min optimal_turb_max max_ammonia market_value harvest_months category description',
  admin_settings: 'id setting_key setting_val updated_at',
  admin_audit_logs: 'id admin_id action details created_at',
  admin_auth_rate: 'bucket attempts resets_at',
  admin_auth_flows: 'token_hash admin_id kind challenge expires_at consumed_at',
  admin_security: 'id admin_id enforced',
  admin_credentials: 'id admin_id credential_id credential_hash public_key signature_counter label created_at last_used_at revoked_at',
  sensor_devices: 'id device_name api_key_hash owner_user_id pairing_code_hash pairing_expires_at is_active last_seen_at created_at',
  sensor_telemetry: 'id device_id owner_user_id turbidity_raw turbidity_voltage turbidity_ntu temperature_c ph client_reading_id sampled_at water_contact_confirmed recorded_at',
  public_monitoring: 'id device_id',
  owner_fishpen_assignments: 'owner_user_id fishpen_id updated_by updated_at',
  harvest_batches: 'id owner_user_id species stocking_date stocked_count target_harvest_date actual_harvest_date harvested_kg selling_price fishpen_name target_weight_g reminder_sms notes sensor_device_id fishpen_id created_at',
  harvest_samples: 'id batch_id sampled_at sample_size average_weight_g notes created_at',
  harvest_mortalities: 'id batch_id mortality_date dead_count notes created_at',
  harvest_events: 'id batch_id harvest_type harvest_date fish_count weight_kg price_per_kg notes created_at',
  harvest_reminder_log: 'id batch_id reminder_day target_date sms_status created_at',
  harvest_observations: 'id batch_id observed_at category notes created_at',
  batch_water_measurements: 'id batch_id parameter_name measurement_value recorded_at',
  recommendation_history: 'id owner_user_id batch_id source_kind source_id parameter_name fishpen_name device_id severity payload recorded_at acknowledged_at',
  planning_sms_log: 'id owner_user_id send_day kind status error_message created_at',
  sms_fishpens: 'id owner_user_id name device_id owner_enabled caretaker_phone caretaker_enabled updated_at',
  sms_water_state: 'fishpen_id parameter_name signature generation measured_at',
  sms_water_attempts: 'id fishpen_id owner_user_id fishpen_name device_id source_id source_kind recipient_type recipient_phone parameter_name severity generation reading_value measured_at message status provider_response provider_message_id provider created_at attempted_at',
  sms_critical_incidents: 'id fishpen_id owner_user_id device_id status opened_at resolved_at',
  sms_critical_state: 'fishpen_id owner_user_id device_id incident_id last_sampled_at counts_json confirmed_json ever_critical_json values_json recovery_started_at',
  sms_critical_notifications: 'id incident_id fishpen_id owner_user_id device_id fishpen_name recipient_type recipient_phone kind critical_keys source_kind source_id measured_at message status provider_response provider_message_id provider created_at attempted_at'
};

const nullableColumns = {
  water_readings: 'ph temperature turbidity ammonia dissolved_oxygen status',
  sensor_telemetry: 'owner_user_id turbidity_ntu temperature_c ph client_reading_id sampled_at',
  harvest_batches: 'actual_harvest_date'
};

// These constraints protect lookups, upserts and duplicate SMS/upload claims.
const requiredUniqueKeys = {
  users: ['phone', 'username'],
  admin_settings: ['setting_key'],
  admin_auth_rate: ['bucket'],
  admin_auth_flows: ['token_hash'],
  admin_security: ['id'],
  admin_credentials: ['credential_hash'],
  sensor_telemetry: ['device_id client_reading_id'],
  owner_fishpen_assignments: ['owner_user_id', 'fishpen_id'],
  harvest_reminder_log: ['batch_id reminder_day target_date'],
  planning_sms_log: ['owner_user_id send_day'],
  recommendation_history: ['owner_user_id batch_id source_kind source_id parameter_name'],
  sms_fishpens: ['device_id'],
  sms_critical_state: ['fishpen_id'],
  sms_critical_notifications: ['incident_id recipient_phone kind source_kind source_id']
};

export async function verifyStartupSchema(db: Pick<Pool, 'query'>) {
  const issues: string[] = [];
  try {
    const names = Object.keys(requiredColumns);
    const [columns] = await db.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, IS_NULLABLE AS is_nullable
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`, [names]);
    const metadata = new Map(columns.map(row => [`${row.table_name}.${row.column_name}`, row.is_nullable]));
    for (const [table, fields] of Object.entries(requiredColumns)) {
      if (!columns.some(row => row.table_name === table)) {
        issues.push(`missing table ${table}`);
        continue;
      }
      for (const field of fields.split(' ')) {
        if (!metadata.has(`${table}.${field}`)) issues.push(`missing column ${table}.${field}`);
      }
    }
    for (const [table, fields] of Object.entries(nullableColumns)) {
      for (const field of fields.split(' ')) {
        if (metadata.get(`${table}.${field}`) === 'NO') issues.push(`${table}.${field} must allow NULL`);
      }
    }
    const [indexes] = await db.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, COLUMN_NAME AS column_name,
              SUB_PART AS sub_part
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND NON_UNIQUE = 0 AND TABLE_NAME IN (?)
       ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, [Object.keys(requiredUniqueKeys)]);
    const keys = new Map<string, string[]>();
    for (const row of indexes) {
      const name = `${row.table_name}.${row.index_name}`;
      const fields = keys.get(name) ?? [];
      fields.push(row.sub_part == null && row.column_name ? row.column_name : '<partial column>');
      keys.set(name, fields);
    }
    for (const [table, indexesNeeded] of Object.entries(requiredUniqueKeys)) {
      for (const index of indexesNeeded) {
        if (![...keys].some(([name, fields]) => name.startsWith(`${table}.`) &&
            [...fields].sort().join(' ') === index.split(' ').sort().join(' '))) {
          issues.push(`missing unique key ${table}(${index.replaceAll(' ', ', ')})`);
        }
      }
    }
    if (!issues.length) {
      const [admin] = await db.query<RowDataPacket[]>(
        `SELECT 1 FROM admin_security s INNER JOIN users u ON u.id = s.admin_id
         WHERE s.id = 1 AND u.role = 'admin' LIMIT 1`);
      if (!admin.length) issues.push('administrator security configuration is missing or does not reference an administrator');
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    const suffix = code && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : '';
    throw new Error(`PondSense startup blocked: unable to verify the MySQL schema${suffix}. Check database connectivity and permissions. No schema changes were attempted.`);
  }
  if (issues.length) {
    throw new Error(`PondSense startup blocked: incompatible MySQL schema: ${issues.join('; ')}. No schema changes were attempted.`);
  }
}
