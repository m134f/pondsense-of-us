import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SensorActionCard } from './SensorActionCard';
import { monitoringAssessment, type MonitoringParameter } from '../lib/monitoringRecommendations';

const recordedAt = '2026-11-22T08:00:00Z';
const now = Date.parse(recordedAt);
const snapshot = { sampledAt: recordedAt, recordedAt, ph: 5, temperatureC: 35, turbidityNtu: 210, dissolvedOxygen: 2.4 };
function row(parameter: MonitoringParameter, reading = snapshot) {
  return monitoringAssessment(reading, now).find(item => item.parameter === parameter)!;
}

test('critical DO advises prompt manual response without waiting and conditional escalation', () => {
  const html = renderToStaticMarkup(<SensorActionCard item={row('dissolvedOxygen')} lang="en" />);
  assert.match(html, /Critical.*2\.4 mg\/L/);
  assert.match(html, /manually start a suitable mechanical aerator or paddle wheel promptly/);
  assert.match(html, /Do not wait for fish to gasp or for a repeat test/);
  assert.match(html, /early harvest only as a last resort if severe distress persists, fish are already marketable, and fisheries staff advise it/);
  assert.match(html, /does not set a numerical DO limit/);
});

test('DO warning prepares aeration; high DO does not prompt aeration or early harvest', () => {
  const warning = renderToStaticMarkup(<SensorActionCard item={row('dissolvedOxygen', { ...snapshot, dissolvedOxygen: 4 })} lang="en" />);
  assert.match(warning, /Warning.*4 mg\/L/);
  assert.match(warning, /Prepare an aerator/);
  assert.doesNotMatch(warning, /Do not wait for fish to gasp/);
  const high = renderToStaticMarkup(<SensorActionCard item={row('dissolvedOxygen', { ...snapshot, dissolvedOxygen: 9 })} lang="en" />);
  assert.match(high, /not an oxygen shortage/);
  assert.doesNotMatch(high, /early harvest|manually start/);
});

test('pH and turbidity explicitly prohibit lake chemical treatments', () => {
  for (const ph of [5, 6.2, 9.2]) {
    assert.match(renderToStaticMarkup(<SensorActionCard item={row('ph', { ...snapshot, ph })} lang="en" />), /Do not add lime, acid, fertilizer/);
  }
  const turbid = renderToStaticMarkup(<SensorActionCard item={row('turbidity')} lang="en" />);
  assert.match(turbid, /Monitoring status: <strong>Critical/);
  assert.match(turbid, /Check water flow around the nets/);
  assert.match(turbid, /Do not add alum, gypsum, fertilizer/);
  assert.match(turbid, /Turbidity \(NTU\) and TSS \(mg\/L\) are not interchangeable/);
  assert.doesNotMatch(turbid, /manually start|early harvest/);
});

test('Filipino labels, keyboard-native disclosures and named source links render', () => {
  const html = renderToStaticMarkup(<SensorActionCard item={row('temperature')} lang="tl" />);
  assert.match(html, /<article aria-labelledby="([^"]+)"[^>]+>.*<h3 id="\1"/);
  assert.match(html, /Temperatura ng Tubig.*Babala.*35 \u00b0C/);
  assert.match(html, /Suriin Muna.*Inirerekomendang Hakbang.*Kailan Hihingi ng Tulong/);
  assert.match(html, /<details[^>]*><summary>Bakit ito ipinapakita\?<\/summary>/);
  assert.match(html, /href="https:\/\/www\.fao\.org\/[^"]+"[^>]*rel="noreferrer"[^>]*>FAO:/);
  assert.match(html, /href="https:\/\/emb\.gov\.ph\/[^"]+"/);
});

test('normal, stale, missing, invalid, and unsourced readings do not render an action card', () => {
  for (const item of [
    row('ph', { ...snapshot, ph: 7 }),
    { ...row('ph'), source: null },
    { ...row('ph'), state: 'stale' as const },
    { ...row('ph'), value: null, state: 'missing' as const },
    row('ph', { ...snapshot, ph: 18 })
  ]) assert.equal(renderToStaticMarkup(<SensorActionCard item={item} lang="en" />), '');
});
