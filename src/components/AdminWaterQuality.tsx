import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, CircleMinus, Droplet, FileText, Radio, Search, TriangleAlert } from 'lucide-react';
import type { FarmerWaterReport } from '../lib/farmerWaterQuality';
import { assessmentIsOutdated } from '../lib/farmerWaterQuality';
import { AdminBadge, AdminLoad, AdminTable, adminTime, type useAdminResource } from './AdminControls';

const statuses = [
  { key: 'safe', label: 'Safe', tone: 'good', Icon: CircleCheck },
  { key: 'warning', label: 'Warning', tone: 'warning', Icon: CircleAlert },
  { key: 'critical', label: 'Critical', tone: 'danger', Icon: TriangleAlert },
  { key: 'noData', label: 'No Data', tone: 'neutral', Icon: CircleMinus }
] as const;
const pageSize = 5;

export function AdminWaterQuality({ resource }: { resource: ReturnType<typeof useAdminResource<FarmerWaterReport>> }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const report = resource.data;
  const query = search.trim().toLowerCase();
  const matching = report?.farmers.filter(row =>
    (!query || [row.name, row.fishpenName].some(value => value?.toLowerCase().includes(query))) &&
    (statusFilter === 'all' || statusFilter === (row.latest?.status ?? 'noData')) &&
    (sourceFilter === 'all' || sourceFilter === row.latest?.source)
  ).sort((a, b) => (b.latest?.assessedAt ?? '').localeCompare(a.latest?.assessedAt ?? '')) ?? [];
  const pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * pageSize;
  const visible = matching.slice(start, start + pageSize);

  return <section className="admin-quality" aria-labelledby="farmer-quality-heading">
    <header className="admin-quality-heading">
      <div>
        <h2 id="farmer-quality-heading"><Droplet size={20} aria-hidden="true" /> Farmer Water Quality Records</h2>
        <p className="admin-muted">Latest assessment per farmer. Safe means the assessed values were in range.</p>
      </div>
      {report && <p className="admin-muted">Last updated: <time dateTime={report.updatedAt}>{adminTime(report.updatedAt)}</time></p>}
    </header>
    <AdminLoad resource={resource} />
    {report && <>
      <dl className="admin-quality-totals">
        {statuses.map(({ key, label, tone, Icon }) => <div key={key} data-tone={tone}>
          <dt><Icon size={17} aria-hidden="true" /> {label}</dt>
          <dd>{report.totals[key].toLocaleString('en-PH')}</dd>
        </div>)}
      </dl>
      <div className="admin-quality-filters">
        <div className="admin-quality-search">
          <Search size={17} aria-hidden="true" />
          <input type="search" aria-label="Search farmer or fishpen" placeholder="Search farmer or fishpen" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <select aria-label="Filter by water quality status" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }}>
          <option value="all">All statuses</option>
          {statuses.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
        </select>
        <select aria-label="Filter by assessment source" value={sourceFilter} onChange={e => { setSourceFilter(e.target.value); setPage(1); }}>
          <option value="all">All sources</option><option value="sensor">Sensor</option><option value="manual">Manual</option>
        </select>
      </div>
      <AdminTable label="Farmer water quality records"
        headings={['Farmer', 'Current fishpen', 'Source', 'Latest status', 'Assessments', 'Last assessment (PHT)']}
        empty={report.farmers.length ? 'No farmer records match these filters.' : 'No farmer accounts yet.'}
        rows={visible.map(({ id, name, fishpenName, latest, counts }) => {
          const { tone, label } = statuses.find(item => item.key === (latest?.status ?? 'noData'))!;
          const SourceIcon = latest?.source === 'sensor' ? Radio : FileText;
          return { id, cells: [
            <strong>{name}</strong>, fishpenName || 'Unassigned',
            latest ? <span className="admin-quality-source" data-source={latest.source}><SourceIcon size={15} aria-hidden="true" />{latest.source === 'sensor' ? 'Sensor' : 'Manual'}</span> : 'None',
            <div className="admin-quality-status"><AdminBadge tone={tone}>{label}</AdminBadge>
              {latest && assessmentIsOutdated(latest, now) && <AdminBadge>Outdated</AdminBadge>}
            </div>,
            <div className="admin-quality-counts">
              {statuses.slice(0, 3).map(({ key: kind, label: statusLabel, tone: countTone }) => kind !== 'noData' &&
                <AdminBadge key={kind} tone={countTone}>{statusLabel} {counts[kind].toLocaleString('en-PH')}</AdminBadge>)}
            </div>,
            latest ? <time dateTime={latest.assessedAt}>{adminTime(latest.assessedAt)}</time> : 'Not assessed'
          ] };
        })} />
      {matching.length > 0 && <footer className="admin-quality-footer">
        <p className="admin-muted" role="status">Showing {start + 1} to {start + visible.length} of {matching.length} farmers</p>
        {pageCount > 1 && <nav className="admin-quality-pagination" aria-label="Farmer records pagination">
          <button type="button" className="soft-button admin-icon-button" disabled={currentPage === 1} aria-label="Previous page" title="Previous page" onClick={() => setPage(currentPage - 1)}><ChevronLeft size={18} aria-hidden="true" /></button>
          <span className="admin-muted">Page {currentPage} of {pageCount}</span>
          <button type="button" className="soft-button admin-icon-button" disabled={currentPage === pageCount} aria-label="Next page" title="Next page" onClick={() => setPage(currentPage + 1)}><ChevronRight size={18} aria-hidden="true" /></button>
        </nav>}
      </footer>}
    </>}
  </section>;
}
