import { useState, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import { AdminBadge, AdminLoad, AdminRefresh, AdminTable, adminTime, exportAdminCsv, useAdminResource } from './AdminControls';

type Entry = Record<string, unknown>;
type Field = { label: string; cell: (row: Entry) => unknown; display?: (value: unknown) => ReactNode };
type Report = { label: string; url: string; result: string; fields: Field[]; note?: string };
const missing = '\u2014';
const blank = (value: unknown) => value == null || value === '' ? missing : String(value);
const text = (label: string, key: string): Field => ({ label, cell: row => row[key] });
const time = (label: string, key: string): Field => ({ label, cell: row => row[key], display: value => adminTime(value) || missing });
const status = (label: string, value: (row: Entry) => string): Field => ({ label, cell: value,
  display: value => <AdminBadge tone={/critical|fail/i.test(String(value)) ? 'danger' : /warning|unknown|unconfirmed/i.test(String(value)) ? 'warning' : 'neutral'}>{blank(value)}</AdminBadge> });
const device = (row: Entry) => row.device_id == null ? '' : `${row.device_name || 'ESP32'} #${row.device_id}`;
const contact = (row: Entry) => Number(row.water_contact_confirmed) === 1 ? 'Confirmed' : 'Unconfirmed';
const waterStatus = (row: Entry) => row.status === 'accepted' ? 'Provider accepted (delivery unconfirmed)' : String(row.status || 'Unknown');
const sentStatus = (value: unknown) => value === 'sent' ? 'Provider accepted (delivery unconfirmed)' : String(value || 'Unknown');
const analysisStatus = (row: Entry) => String(row.status || 'Not classified');

const telemetry: Report = {
  label: 'ESP32 uploads', url: '/api/admin/telemetry', result: 'readings',
  note: 'Latest 250 stored uploads. Fishpen is shown only when recorded at upload.',
  fields: [text('Telemetry ID', 'id'), time('Sample time', 'sampled_at'), time('Upload time', 'recorded_at'), { label: 'Device', cell: device }, text('Farmer at upload', 'owner_name'), text('Fishpen at upload', 'fishpen_at_upload'),
    text('pH', 'ph'), text('Temp (\u00b0C)', 'temperature_c'), text('DO (mg/L)', 'dissolved_oxygen'), text('Turbidity (NTU)', 'turbidity_ntu'), status('Water contact', contact)]
};
const analyses = (mode: 'manual' | 'sensor'): Report => ({
  label: mode === 'manual' ? 'Manual analyses' : 'Saved sensor analyses', url: `/api/admin/logs?mode=${mode}`, result: 'logs',
  note: 'Latest 250 saved analyses in this view. Missing fields and unclassified records are not assumed safe.',
  fields: [time('Recorded', 'recorded_at'), text('Farmer', 'full_name'), text('pH', 'ph'), text('Temp (\u00b0C)', 'temperature'), text('DO (mg/L)', 'dissolved_oxygen'),
    text('Turbidity (NTU)', 'turbidity'), text('NH3 (mg/L)', 'ammonia'), text('Best fish', 'best_fish'), text('Score', 'best_score'), status('Status', analysisStatus)]
});
const waterSms: Report = {
  label: 'Fishpen water SMS', url: '/api/admin/water-sms', result: 'logs',
  note: 'Latest 200 attempts. Provider acceptance is not confirmation of handset delivery.',
  fields: [time('Logged', 'created_at'), time('Measured', 'measured_at'), text('Fishpen', 'fishpen_name'), { label: 'Recipient', cell: row => [row.recipient_type, row.recipient_phone].filter(Boolean).join(' ') },
    { label: 'Alert', cell: row => [row.kind, row.parameter_name, row.reading_value, row.severity].filter(value => value != null && value !== '').join(' / ') }, text('Message', 'message'),
    status('Result', waterStatus), text('Provider ID', 'provider_message_id'), text('Provider response', 'provider_response')]
};
const legacySms: Report = {
  label: 'Legacy SMS alerts', url: '/api/admin/alerts', result: 'alerts', note: 'Latest 250 legacy alert records. Provider acceptance is not confirmation of handset delivery.',
  fields: [time('Logged', 'sent_at'), text('Farmer', 'full_name'), text('Alert', 'alert_type'), text('Severity', 'severity'), text('Message', 'message'),
    status('Result', row => sentStatus(row.sms_status || (Number(row.sms_sent) === 1 ? 'sent' : 'skipped'))), text('Reason', 'sms_error')]
};
const planning: Report = {
  label: 'Planning SMS attempts', url: '/api/admin/planning-sms', result: 'logs', note: 'Latest 250 planning attempts. Provider acceptance is not confirmation of handset delivery.',
  fields: [time('Logged', 'created_at'), text('Farmer', 'full_name'), text('Recipient', 'phone'), text('Type', 'kind'), status('Result', row => sentStatus(row.status)), text('Reason', 'error_message')]
};

function AdminRecordTable({ report, match }: { report: Report; match: (entry: Entry) => boolean }) {
  const resource = useAdminResource<Record<string, Entry[]>>(report.url);
  const rows = (resource.data?.[report.result] ?? []).filter(match);
  const headings = report.fields.map(field => field.label);
  return <div className="admin-record-table">
    <div className="admin-section-heading">
      <div><h3>{report.label}</h3>{report.note && <p className="admin-muted">{report.note}</p>}</div>
      <div className="admin-actions">
        <AdminRefresh busy={resource.busy} refresh={resource.refresh} />
        <button type="button" className="soft-button" disabled={!rows.length} onClick={() =>
          exportAdminCsv(`pondsense-${report.label.toLowerCase().replaceAll(' ', '-')}.csv`, headings, rows.map(row => report.fields.map(field => field.cell(row))))}>
          <Download size={16} aria-hidden="true" /> Export CSV
        </button>
      </div>
    </div>
    <AdminLoad resource={resource} />
    {resource.data && <AdminTable label={report.label} headings={headings} empty="No matching recent records."
      rows={rows.map(row => ({ id: `${row.log_type ?? ''}-${row.id}`, cells: report.fields.map(({ cell, display }) => display ? display(cell(row)) : blank(cell(row))) }))} />}
  </div>;
}

const farmerReports = [
  { report: analyses('manual'), ownerField: 'user_id' },
  { report: analyses('sensor'), ownerField: 'user_id' },
  { report: waterSms, ownerField: 'owner_user_id' },
  { report: legacySms, ownerField: 'user_id' },
  { report: planning, ownerField: 'owner_user_id' }
];

export function FarmerRecords({ ownerId }: { ownerId: number }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const { report, ownerField } = farmerReports[selected];
  return <details className="admin-detail-section" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Farmer records</summary>
    {open && <>
      <label className="admin-species-select">Record type
        <select value={selected} onChange={event => setSelected(Number(event.target.value))}>
          {farmerReports.map(({ report }, index) => <option key={report.url} value={index}>{report.label}</option>)}
        </select>
      </label>
      <AdminRecordTable key={report.url} report={report} match={row => Number(row[ownerField]) === ownerId} />
    </>}
  </details>;
}

export function DeviceRecords({ deviceId }: { deviceId: number }) {
  const [open, setOpen] = useState(false);
  return <details className="admin-detail-section" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Upload history</summary>
    {open && <AdminRecordTable report={telemetry} match={row => Number(row.device_id) === deviceId} />}
  </details>;
}
