const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBill, countWeekdaysInRange, isWeekday } = require('../server/billing');

// September 2026: 1 Sep is a Tuesday. Weekdays: Sep 1-4, 7-11, 14-18, 21-25, 28-30 = 22 weekdays.
const YEAR = 2026;
const MONTH = 9;

test('isWeekday: correctly flags weekends', () => {
  assert.equal(isWeekday(new Date(2026, 8, 5)), false); // Sep 5 2026 is a Saturday
  assert.equal(isWeekday(new Date(2026, 8, 6)), false); // Sep 6 2026 is a Sunday
  assert.equal(isWeekday(new Date(2026, 8, 7)), true); // Sep 7 2026 is a Monday
});

test('countWeekdaysInRange: full September 2026 has 22 weekdays', () => {
  const start = new Date(2026, 8, 1);
  const end = new Date(2026, 8, 30);
  assert.equal(countWeekdaysInRange(start, end), 22);
});

test('computeBill: no pauses -> full plan price', () => {
  const bill = computeBill(3000, [], YEAR, MONTH, new Date(2026, 9, 5));
  assert.equal(bill.totalWeekdays, 22);
  assert.equal(bill.pausedWeekdays, 0);
  assert.equal(bill.deliveredDays, 22);
  assert.equal(bill.amount, 3000);
});

test('computeBill: pause fully inside the month reduces the bill proportionally', () => {
  // Paused Sep 7 (Mon) through Sep 11 (Fri) inclusive = 5 weekdays paused, resumed Sep 14.
  const pausePeriods = [{ paused_from: '2026-09-07', resumed_on: '2026-09-14' }];
  const bill = computeBill(2200, pausePeriods, YEAR, MONTH, new Date(2026, 9, 20));
  assert.equal(bill.totalWeekdays, 22);
  assert.equal(bill.pausedWeekdays, 5);
  assert.equal(bill.deliveredDays, 17);
  assert.equal(bill.amount, Math.round(((2200 * 17) / 22) * 100) / 100);
});

test('computeBill: pause spanning a month boundary only counts days inside the queried month', () => {
  // Paused Aug 28 -> Sep 3 (resume). Only Sep 1-2 (weekdays inside Sept) should count as paused.
  const pausePeriods = [{ paused_from: '2026-08-28', resumed_on: '2026-09-03' }];
  const bill = computeBill(3000, pausePeriods, YEAR, MONTH, new Date(2026, 9, 10));
  // Sep 1 (Tue), Sep 2 (Wed) are paused weekdays inside September; Sep 3 is the resume day (delivered).
  assert.equal(bill.pausedWeekdays, 2);
});

test('computeBill: an open pause (no resume yet) is clipped to "today"', () => {
  // Paused starting Sep 14 (Mon), never resumed, "today" is Sep 18 (Fri).
  const pausePeriods = [{ paused_from: '2026-09-14', resumed_on: null }];
  const today = new Date(2026, 8, 18);
  const bill = computeBill(3000, pausePeriods, YEAR, MONTH, today);
  // Sep 14-18 inclusive = 5 weekdays paused so far.
  assert.equal(bill.pausedWeekdays, 5);
});

test('computeBill: two separate pause periods in the same month both subtract', () => {
  const pausePeriods = [
    { paused_from: '2026-09-07', resumed_on: '2026-09-09' }, // Sep 7-8 paused (2 weekdays)
    { paused_from: '2026-09-21', resumed_on: '2026-09-23' }, // Sep 21-22 paused (2 weekdays)
  ];
  const bill = computeBill(3000, pausePeriods, YEAR, MONTH, new Date(2026, 8, 30));
  assert.ok(bill.pausedWeekdays > 0);
  assert.equal(bill.deliveredDays, bill.totalWeekdays - bill.pausedWeekdays);
});

test('computeBill: a weekend-only pause has zero billing impact', () => {
  // Sep 12 2026 is a Saturday, Sep 13 is Sunday; "pause" over the weekend, resume Sep 14 (Mon).
  const pausePeriods = [{ paused_from: '2026-09-12', resumed_on: '2026-09-14' }];
  const bill = computeBill(3000, pausePeriods, YEAR, MONTH, new Date(2026, 8, 20));
  assert.equal(bill.pausedWeekdays, 0);
  assert.equal(bill.amount, 3000);
});

test('computeBill: never goes negative even with an overlapping/odd pause window', () => {
  const pausePeriods = [{ paused_from: '2026-09-01', resumed_on: null }];
  const bill = computeBill(3000, pausePeriods, YEAR, MONTH, new Date(2026, 9, 30));
  assert.ok(bill.amount >= 0);
  assert.ok(bill.deliveredDays >= 0);
});

test('computeTransferSplit: splits September 2026 weekdays at the effective date', () => {
  const { computeTransferSplit } = require('../server/billing');
  const split = computeTransferSplit(2200, [], [], 2026, 9, '2026-09-14', new Date(2026, 8, 30));
  // Sep 1-11 = 9 weekdays; Sep 14-30 = 13 weekdays.
  assert.equal(split.totalWeekdays, 22);
  assert.equal(split.oldDeliveredDays, 9);
  assert.equal(split.newDeliveredDays, 13);
  assert.equal(split.oldAmount + split.newAmount, 2200);
});

test('computeTransferSplit: pauses are applied independently on each side', () => {
  const { computeTransferSplit } = require('../server/billing');
  const split = computeTransferSplit(
    3000,
    [{ paused_from: '2026-09-07', resumed_on: '2026-09-09' }],
    [{ paused_from: '2026-09-21', resumed_on: '2026-09-23' }],
    2026, 9, '2026-09-14', new Date(2026, 8, 30)
  );
  assert.equal(split.oldDeliveredDays, 7); // 9 weekdays before transfer minus Sep 7-8 pause.
  assert.equal(split.newDeliveredDays, 11); // 13 weekdays after transfer minus Sep 21-22 pause.
  assert.equal(split.oldDeliveredDays + split.newDeliveredDays, 18);
});
