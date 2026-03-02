'use strict';

/**
 * Returns UTC day boundaries for (today + daysAhead).
 * e.g. daysAhead=3 → start/end of that full UTC day.
 */
function getTargetDayWindow(daysAhead = 3) {
  const now = new Date();
  const target = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + daysAhead
  ));

  const startOfTargetDay = new Date(Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    target.getUTCDate(),
    0, 0, 0, 0
  ));

  const endOfTargetDay = new Date(Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    target.getUTCDate(),
    23, 59, 59, 999
  ));

  return { startOfTargetDay, endOfTargetDay };
}

/**
 * Returns a Date representing exactly 48 hours ago from now.
 */
function getFortyEightHoursAgo() {
  return new Date(Date.now() - 48 * 60 * 60 * 1000);
}

module.exports = { getTargetDayWindow, getFortyEightHoursAgo };
