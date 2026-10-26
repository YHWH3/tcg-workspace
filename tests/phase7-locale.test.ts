import {describe,it,expect} from 'vitest';
import {workspaceToday,monthGrid,scaleRange} from '../shared/dates';
import {formatNumber,type FieldDef} from '../shared/fields';
import {validCurrency,validTimeZone} from '../shared/workspaceSettings';
describe('workspace locale',()=>{
 it('uses the configured day across midnight and DST',()=>{
  const now=Date.parse('2026-10-24T20:00:00Z');
  expect(workspaceToday(now,'UTC')).toBe('2026-10-24');expect(workspaceToday(now,'Asia/Kolkata')).toBe('2026-10-25');
  expect(workspaceToday(Date.parse('2026-03-08T06:59Z'),'America/New_York')).toBe('2026-03-08');
  expect(workspaceToday(Date.parse('2026-03-08T07:01Z'),'America/New_York')).toBe('2026-03-08');
 });
 it('aligns calendar cells and timeline ticks to the chosen week start',()=>{
  expect(monthGrid(2026,10,0)[0].date).toBe('2026-09-27');expect(monthGrid(2026,10,1)[0].date).toBe('2026-09-28');
  expect(scaleRange('week','2026-10-25',0)?.start).toBe('2026-10-25');expect(scaleRange('week','2026-10-25',1)?.start).toBe('2026-10-19');
 });
 it('accepts zone aliases and actual currency codes, not arbitrary three letters',()=>{
  expect(validTimeZone('UTC')).toBe(true);expect(validTimeZone('Asia/Kolkata')).toBe(true);expect(validTimeZone('No/Such')).toBe(false);
  expect(validCurrency('INR')).toBe(true);expect(validCurrency('USD')).toBe(true);expect(validCurrency('XYZ')).toBe(false);expect(validCurrency('inr')).toBe(false);
 });
 it('uses explicit field currency ahead of the workspace without converting values',()=>{
  const def:FieldDef={id:'amount',name:'Amount',type:'number',format:'currency'};
  expect(formatNumber(1234.5,def,'INR')).toContain('₹');
  expect(formatNumber(1234.5,{...def,currency:'USD'},'INR')).toContain('$');
  expect(formatNumber(1234.5,{...def,currency:'USD'},'INR')).toContain('1,234.50');
  expect(formatNumber(.25,{...def,format:'percent'},'INR')).toBe('25%');
  expect(formatNumber(1234.5,{...def,format:'plain'},'INR')).toBe('1234.5');
 });
});
