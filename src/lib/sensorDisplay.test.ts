import test from 'node:test';
import assert from 'node:assert/strict';
import { sensorTurbidityValue } from './sensorDisplay';

test('calibrated NTU is never capped by a presentation limit', () => {
  for (const value of [0, 133.25, 500, 750.5, 1000]) assert.equal(sensorTurbidityValue({turbidityNtu:value,rawValue:2000}),value);
});
test('provisional NTU matches the LCD conversion across every 12-bit ADC sample', () => {
  for(let raw=0;raw<=4095;raw++){
    const lcd=Math.round(Math.fround(Math.fround(1-Math.fround(raw/4095))*250));
    assert.equal(sensorTurbidityValue({turbidityNtu:null,rawValue:raw}),lcd);
  }
});
