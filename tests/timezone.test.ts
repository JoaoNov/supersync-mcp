import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarDay,DEFAULT_TIME_ZONE} from '../src/dates.js';

test('calendar days default to Europe/Brussels and follow an explicit zone',()=>{
 assert.equal(DEFAULT_TIME_ZONE,'Europe/Brussels');
 assert.equal(calendarDay(Date.parse('2026-01-15T23:30:00Z'),'Europe/Brussels'),'2026-01-16');
 assert.equal(calendarDay(Date.parse('2026-07-15T21:30:00Z'),'Europe/Brussels'),'2026-07-15');
 assert.equal(calendarDay(Date.parse('2026-07-15T22:30:00Z'),'Europe/Brussels'),'2026-07-16');
 assert.equal(calendarDay(Date.parse('2026-10-15T07:00:00Z'),'Europe/Brussels'),'2026-10-15');
 assert.equal(calendarDay(Date.parse('2026-01-15T23:30:00Z'),'UTC'),'2026-01-15');
 assert.equal(calendarDay(Date.parse('2026-01-15T12:00:00Z'),'Pacific/Auckland'),'2026-01-16');
 assert.throws(()=>calendarDay(Date.now(),'Not/AZone'),/TIMEZONE_INVALID/);
});
