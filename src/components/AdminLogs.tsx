import { useId, useState, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import { AdminBadge, AdminHeading, AdminLoad, AdminRefresh, AdminTable, adminTime, exportAdminCsv, useAdminResource } from './AdminControls';

type Entry = Record<string, unknown>;
type Field = { label: string; cell: (row: Entry) => unknown; display?: (value: unknown) => ReactNode };
type Report = { label: string; url: string; result: string; fields: Field[]; filter?: { label: string; value: (row: Entry) => string }; note?: string };
const tabs = ['Sensor Readings', 'Water SMS Logs', 'Planning SMS Logs', 'Admin Audit Logs'] as const;
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
  note: 'Latest 250 stored uploads. Farmer reflects ownership at upload. Historical fishpen IDs are not recorded.',
  fields: [time('Sample time', 'sampled_at'), time('Upload time', 'recorded_at'), { label: 'Device', cell: device }, text('Farmer at upload', 'owner_name'),
    text('pH', 'ph'), text('Temp (\u00b0C)', 'temperature_c'), text('Turbidity (NTU)', 'turbidity_ntu'), status('Water contact', contact)],
  filter: { label: 'Water contact', value: contact }
};
const analyses = (mode: 'manual' | 'sensor'): Report => ({
  label: mode === 'manual' ? 'Manual analyses' : 'Saved sensor analyses', url: `/api/admin/logs?mode=${mode}`, result: 'logs',
  note: 'Latest 250 saved analyses in this view. Missing fields and unclassified records are not assumed safe.',
  fields: [time('Recorded', 'recorded_at'), text('Farmer', 'full_name'), text('pH', 'ph'), text('Temp (\u00b0C)', 'temperature'), text('DO (mg/L)', 'dissolved_oxygen'),
    text('Turbidity (NTU)', 'turbidity'), text('NH3 (mg/L)', 'ammonia'), text('Best fish', 'best_fish'), text('Score', 'best_score'), status('Status', analysisStatus)],
  filter: { label: 'Analysis status', value: analysisStatus }
});
const waterSms: Report = {
  label: 'Fishpen water SMS', url: '/api/admin/water-sms', result: 'logs',
  note: 'Latest 200 attempts. Provider acceptance is not confirmation of handset delivery.',
  fields: [time('Logged', 'created_at'), time('Measured', 'measured_at'), text('Fishpen', 'fishpen_name'), { label: 'Recipient', cell: row => [row.recipient_type, row.recipient_phone].filter(Boolean).join(' ') },
    { label: 'Alert', cell: row => [row.kind, row.parameter_name, row.reading_value, row.severity].filter(value => value != null && value !== '').join(' / ') }, text('Message', 'message'),
    status('Result', waterStatus), text('Provider ID', 'provider_message_id'), text('Provider response', 'provider_response')], filter: { label: 'SMS status', value: waterStatus }
};
const legacySms: Report = {
  label: 'Legacy SMS alerts', url: '/api/admin/alerts', result: 'alerts', note: 'Latest 250 legacy alert records. Provider acceptance is not confirmation of handset delivery.',
  fields: [time('Logged', 'sent_at'), text('Farmer', 'full_name'), text('Alert', 'alert_type'), text('Severity', 'severity'), text('Message', 'message'),
    status('Result', row => sentStatus(row.sms_status || (Number(row.sms_sent) === 1 ? 'sent' : 'skipped'))), text('Reason', 'sms_error')],
  filter: { label: 'SMS status', value: row => sentStatus(row.sms_status || (Number(row.sms_sent) === 1 ? 'sent' : 'skipped')) }
};
const planning: Report = {
  label: 'Planning SMS attempts', url: '/api/admin/planning-sms', result: 'logs', note: 'Latest 250 planning attempts. Provider acceptance is not confirmation of handset delivery.',
  fields: [time('Logged', 'created_at'), text('Farmer', 'full_name'), text('Recipient', 'phone'), text('Type', 'kind'), status('Result', row => sentStatus(row.status)), text('Reason', 'error_message')],
  filter: { label: 'SMS status', value: row => sentStatus(row.status) }
};
const audit: Report = {
  label: 'Admin audit activity', url: '/api/admin/audit-logs', result: 'auditLogs', note: 'Latest 250 recorded admin actions.',
  fields: [time('Logged', 'created_at'), { label: 'Administrator', cell: row => row.full_name || row.username || 'Unknown admin' },
    { label: 'Action', cell: row => String(row.action || '').replaceAll('_', ' ') }, text('Details', 'details')],
  filter: { label: 'Action', value: row => String(row.action || '').replaceAll('_', ' ') }
};

function AdminReport({ report }: { report: Report }) {
  const resources = useAdminResource<Record<string, Entry[]>>(report.url);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const entries = resources.data?.[report.result] ?? [];
  const options = report.filter ? [...new Set(entries.map(report.filter.value))].filter(Boolean).sort() : [];
  const query = search.trim().toLowerCase();
  const rows = entries.filter(row => (!filter || report.filter?.value(row) === filter) &&
    (!query || report.fields.map(field => field.cell(row)).concat(row.phone).join(' ').toLowerCase().includes(query)));
  const titles = report.fields.map(field => field.label);
  const filename = `pondsense-${report.label.toLowerCase().replaceAll(' ', '-')}.csv`;
  return <section className="admin-panel">
    <header className="admin-section-heading"><div><h2>{report.label}</h2>{report.note && <p className="admin-muted">{report.note}</p>}</div>
      <AdminRefresh busy={resources.busy} refresh={resources.refresh} />
    </header>
    <div className="admin-filters">
      <input type="search" aria-label={`Search ${report.label}`} placeholder="Search records" value={search} onChange={e => setSearch(e.target.value)} />
      {report.filter && <select aria-label={report.filter.label} value={filter} onChange={e => setFilter(e.target.value)}><option value="">All results</option>{options.map(option => <option key={option}>{option}</option>)}</select>}
      <button type="button" className="soft-button" disabled={!rows.length} onClick={() => exportAdminCsv(filename, titles, rows.map(row => report.fields.map(field => field.cell(row))))}><Download size={16} aria-hidden="true" /> Export CSV</button>
    </div>
    <AdminLoad resource={resources} />
    {resources.data && <><p className="admin-muted">{rows.length} of {entries.length} shown</p><AdminTable label={report.label} headings={titles} empty="No records match."
      rows={rows.map(row => ({ id: `${row.log_type ?? ''}-${row.id}`, cells: report.fields.map(({ cell, display }) => display ? display(cell(row)) : blank(cell(row))) }))} /></>}
  </section>;
}

export function AdminLogs() {
  const id = useId();
  const [tab, setTab] = useState(0);
  const [readings, setReadings] = useState('uploads');
  const [sms, setSms] = useState('fishpen');
  const report = tab === 0 ? readings === 'uploads' ? telemetry : analyses(readings === 'manual' ? 'manual' : 'sensor') :
    tab === 1 ? sms === 'fishpen' ? waterSms : legacySms : tab === 2 ? planning : audit;
  return <>
    <AdminHeading title="Logs" caption="Readings, SMS attempts, and administrator activity" />
    <div className="admin-tabs" role="tablist" aria-label="Log categories">{tabs.map((label, index) => <button key={label} type="button" role="tab" id={`${id}-tab-${index}`}
      aria-selected={tab === index} aria-controls={`${id}-panel-${index}`} tabIndex={tab === index ? 0 : -1} onClick={() => setTab(index)} onKeyDown={e => {
        const next = e.key === 'ArrowRight' ? (index + 1) % tabs.length : e.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
        if (next === null) return;
        e.preventDefault(); setTab(next); document.getElementById(`${id}-tab-${next}`)?.focus();
      }}>{label}</button>)}</div>
    {tabs.map((label, index) => <div key={label} role="tabpanel" id={`${id}-panel-${index}`} aria-labelledby={`${id}-tab-${index}`} hidden={tab !== index}>
      {tab === index && <div className="admin-log-panel">
        {index === 0 && <label className="admin-view-select">Reading source <select value={readings} onChange={e => setReadings(e.target.value)}>
          <option value="uploads">ESP32 uploads</option><option value="manual">Manual analyses</option><option value="sensor">Saved sensor analyses</option>
        </select></label>}
        {index === 1 && <label className="admin-view-select">SMS source <select value={sms} onChange={e => setSms(e.target.value)}><option value="fishpen">Fishpen water SMS</option><option value="legacy">Legacy SMS alerts</option></select></label>}
        <AdminReport key={report.url} report={report} />
      </div>}
    </div>)}
  </>;
}
