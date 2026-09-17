// ---------------------------------------------------------------------
// Pro-rated billing for the tiffin service.
//
// Assumptions (stated explicitly — see REASONING.md for the "why"):
//  - A "delivery day" is any weekday (Mon-Fri) in the billing month.
//    Weekends are never billed, paused or not.
//  - `paused_from` is the FIRST day the customer stops getting lunch.
//  - `resumed_on` is the day deliveries START AGAIN, i.e. it is itself
//    a delivered day, not a paused one.
//  - A pause with no `resumed_on` yet is "still open"; it's clipped to
//    today (or month-end, whichever is earlier) for billing purposes.
//  - Bill = planPrice * (deliveredWeekdays / totalWeekdaysInMonth).
// ---------------------------------------------------------------------

function isWeekday(date) {
  const day = date.getDay(); // 0 = Sun ... 6 = Sat
  return day !== 0 && day !== 6;
}

function stripTime(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function countWeekdaysInRange(start, end) {
  // Inclusive of both ends.
  let count = 0;
  const cur = stripTime(start);
  const stop = stripTime(end);
  while (cur <= stop) {
    if (isWeekday(cur)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function clampRange(start, end, boundStart, boundEnd) {
  const s = start > boundStart ? start : boundStart;
  const e = end < boundEnd ? end : boundEnd;
  return s <= e ? { start: s, end: e } : null;
}

/**
 * @param {number} planPrice monthly plan price
 * @param {Array<{paused_from: string, resumed_on: string|null}>} pausePeriods
 * @param {number} year e.g. 2026
 * @param {number} month 1-12
 * @param {Date} today used to clip a pause that hasn't resumed yet
 */
function computeBill(planPrice, pausePeriods, year, month, today = new Date()) {
  const monthStart = stripTime(new Date(year, month - 1, 1));
  const monthEnd = stripTime(new Date(year, month, 0)); // last calendar day of month

  const totalWeekdays = countWeekdaysInRange(monthStart, monthEnd);
  if (totalWeekdays === 0) {
    return { totalWeekdays: 0, pausedWeekdays: 0, deliveredDays: 0, amount: 0 };
  }

  let pausedWeekdays = 0;
  const t = stripTime(today);

  for (const p of pausePeriods) {
    const pFrom = stripTime(p.paused_from);
    let pTo;
    if (p.resumed_on) {
      // the resume day itself is delivered, so the paused window ends the day before
      pTo = stripTime(p.resumed_on);
      pTo.setDate(pTo.getDate() - 1);
    } else {
      pTo = t < monthEnd ? t : monthEnd;
    }

    const clipped = clampRange(pFrom, pTo, monthStart, monthEnd);
    if (clipped) {
      pausedWeekdays += countWeekdaysInRange(clipped.start, clipped.end);
    }
  }

  const deliveredDays = Math.max(0, totalWeekdays - pausedWeekdays);
  const amount = Math.round(((planPrice * deliveredDays) / totalWeekdays) * 100) / 100;

  return { totalWeekdays, pausedWeekdays, deliveredDays, amount };
}

module.exports = { computeBill, countWeekdaysInRange, isWeekday };

/**
 * Split a transfer-month bill at an inclusive effective date.
 * Days before the effective date belong to the old identity; the effective
 * date and later days belong to the new identity. Pause periods for each
 * identity are applied within their respective side of the split.
 */
function computeTransferSplit(planPrice, oldPausePeriods, newPausePeriods, year, month, effectiveOn, today = new Date()) {
  const monthStart = stripTime(new Date(year, month - 1, 1));
  const monthEnd = stripTime(new Date(year, month, 0));
  const effective = stripTime(new Date(`${effectiveOn}T00:00:00`));
  const totalWeekdays = countWeekdaysInRange(monthStart, monthEnd);
  if (Number.isNaN(effective.getTime()) || effective < monthStart || effective > monthEnd) {
    return null;
  }
  const dayBefore = new Date(effective);
  dayBefore.setDate(dayBefore.getDate() - 1);
  const countDelivered = (periods, start, end) => {
    if (start > end) return 0;
    let delivered = countWeekdaysInRange(start, end);
    const todayDate = stripTime(today);
    for (const p of periods) {
      const from = stripTime(p.paused_from);
      let to = p.resumed_on ? stripTime(p.resumed_on) : todayDate;
      if (p.resumed_on) to.setDate(to.getDate() - 1);
      const s = from > start ? from : start;
      const e = to < end ? to : end;
      if (s <= e) delivered -= countWeekdaysInRange(s, e);
    }
    return Math.max(0, delivered);
  };
  const oldDays = countDelivered(oldPausePeriods, monthStart, dayBefore);
  const newDays = countDelivered(newPausePeriods, effective, monthEnd);
  const perDay = planPrice / Math.max(1, totalWeekdays);
  return {
    totalWeekdays,
    oldDeliveredDays: oldDays,
    newDeliveredDays: newDays,
    oldAmount: Math.round(oldDays * perDay * 100) / 100,
    newAmount: Math.round(newDays * perDay * 100) / 100,
  };
}

module.exports.computeTransferSplit = computeTransferSplit;
