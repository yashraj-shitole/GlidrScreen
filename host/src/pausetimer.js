'use strict';
// Timed pause: "Pause for 1 hour" / "Pause until tomorrow 08:00". Pure logic with injectable clock and timers.
// Nothing is persisted: a restart of the app resumes sharing.

const HOUR_MS = 60 * 60 * 1000;

/** The next time the local clock shows [hour]:00. At exactly [hour]:00 or later, that is tomorrow. */
function nextLocalHour(now, hour = 8) {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const pad = (n) => String(n).padStart(2, '0');

/** "18:00" today, "tomorrow 08:00" on the next day, a date for anything further out. */
function formatResume(at, now) {
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (t) => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const diffDays = Math.round((day(at) - day(now)) / (24 * HOUR_MS));
  if (diffDays <= 0) return time;
  if (diffDays === 1) return `tomorrow ${time}`;
  return `${d.getDate()}/${d.getMonth() + 1} ${time}`;
}

/** "Paused, resumes at 18:00" / "Paused, resumes tomorrow 08:00". */
function pausedLabel(at, now) {
  const when = formatResume(at, now);
  return `Paused, resumes ${/^\d\d:\d\d$/.test(when) ? 'at ' : ''}${when}`;
}

/** Tray label for the overnight pause: it only says "tomorrow" when 08:00 is not still ahead today. */
function untilLabel(now, hour = 8) {
  const at = nextLocalHour(now, hour);
  return `Pause until ${formatResume(at, now) === `${pad(hour)}:00` ? '' : 'tomorrow '}${pad(hour)}:00`;
}

class PauseTimer {
  /**
   * @param {{onResume: () => void, now?: () => number, setTimer?: Function, clearTimer?: Function}} o
   */
  constructor({ onResume, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.onResume = onResume;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.resumeAt = 0;
    this.handle = null;
  }

  get active() { return this.resumeAt > 0; }

  /** Arms the timer for [ms] from now. Returns the resume time (epoch ms). */
  pauseFor(ms) { return this.#arm(this.now() + ms); }

  /** Arms the timer for the next [hour]:00 local time. */
  pauseUntilHour(hour = 8) { return this.#arm(nextLocalHour(this.now(), hour)); }

  #arm(at) {
    this.clear();
    this.resumeAt = at;
    // setTimeout caps at 2^31-1 ms; check() re-arms for longer waits
    this.handle = this.setTimer(() => this.check(), Math.min(Math.max(at - this.now(), 0), 2 ** 31 - 1));
    return at;
  }

  /** A manual pause/resume overrides the timer. */
  clear() {
    if (this.handle !== null) this.clearTimer(this.handle);
    this.handle = null;
    this.resumeAt = 0;
  }

  /** Fires the resume when it is due. Also called after the PC wakes, when timers may have fired late or not at all. */
  check() {
    if (!this.active) return false;
    if (this.now() < this.resumeAt) { this.#arm(this.resumeAt); return false; }
    this.clear();
    this.onResume();
    return true;
  }

  /** Text for the status pill / tray tooltip, or null when no timer is running. */
  label() { return this.active ? pausedLabel(this.resumeAt, this.now()) : null; }
}

module.exports = { PauseTimer, untilLabel, nextLocalHour, formatResume, pausedLabel, HOUR_MS };
