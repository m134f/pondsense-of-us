import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ManualAssessment, ManualRecommendedActions } from './ManualAssessment';

test('pH 9 and 35 °C are both Warning, not Critical; unmeasured values remain missing', () => {
  const html = renderToStaticMarkup(<ManualAssessment values={{ ph: 9, temperature: 35 }} lang="en" />);
  assert.match(html, /Water quality summary.*Warning.*2 of 4 measured/);
  assert.match(html, /Missing: 2/);
  assert.match(html, /Dissolved Oxygen \(DO\).*No Measurement/);
  assert.match(html, /not live sensor data/);
  assert.match(html, /do not confirm overall water safety/);
  assert.doesNotMatch(html, /Check First/);
  const actions = renderToStaticMarkup(<ManualRecommendedActions values={{ ph: 9, temperature: 35 }} lang="en" />);
  assert.equal((actions.match(/role="tab"/g) ?? []).length, 2);
  assert.match(actions, /aria-selected="true"[^>]*aria-label="pH, Warning"/);
  assert.match(actions, /aria-selected="false"[^>]*aria-label="Water Temperature, Warning"/);
  assert.match(actions, /Why does this matter/);
  assert.match(actions, /href="https:\/\/www\.fao\.org\//);
});

test('measured zero remains valid, critical takes priority, and advice is translated', () => {
  const values = { ph: 9, temperature: 35, dissolvedOxygen: 0, turbidity: 210 };
  const html = renderToStaticMarkup(<ManualAssessment values={values} lang="tl" />);
  assert.match(html, /Buod ng kalidad ng tubig.*Kritikal.*4 sa 4 nasukat/);
  assert.match(html, /Kritikal na DO:.*paandarin agad nang mano-mano/);
  const actions = renderToStaticMarkup(<ManualRecommendedActions values={values} lang="tl" />);
  assert.equal((actions.match(/<article /g) ?? []).length, 1);
  assert.match(actions, /aria-selected="true"[^>]*aria-label="Natunaw na Oxygen \(DO\), Kritikal"/);
  assert.match(actions, /class="manual-guidance-value">0 mg\/L.*?paandarin agad nang mano-mano/);
  assert.match(actions, /Bakit mahalaga ito/);
  assert.doesNotMatch(actions, /Kalagayan sa Monitoring/);
});

test('critical DO opens first even alongside critical pH; in-range tests have no actions', () => {
  const actions = renderToStaticMarkup(<ManualRecommendedActions values={{ ph: 5, dissolvedOxygen: 2 }} lang="en" />);
  assert.match(actions, /aria-selected="true"[^>]*aria-label="Dissolved Oxygen \(DO\), Critical"/);
  assert.equal(renderToStaticMarkup(<ManualRecommendedActions values={{ ph: 7, temperature: 26 }} lang="en" />), '');
});
