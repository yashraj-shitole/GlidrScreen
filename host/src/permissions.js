'use strict';
// Per-phone permissions. Pure functions over a settings slot; every field is optional so slots written by older
// versions keep working (no field = full access, never expires, no session limit).
//
//   viewOnly       true: the phone can watch but never send input or write the clipboard
//   expiresAt      ms epoch after which the phone is refused ('expired'); 0 / missing = never
//   maxSessionMin  longest single session in minutes; 0 / missing = unlimited

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** The only values the control panel may send for a phone's access length. */
const EXPIRES_IN = Object.freeze({ never: 0, '1h': HOUR_MS, '1d': DAY_MS, '7d': 7 * DAY_MS });

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function isExpired(slot, now) {
  const at = num(slot?.expiresAt);
  return at > 0 && now >= at;
}

/** Control input needs the PC-wide switch on AND a phone that is not view only. */
function canControl(slot, globalAllow) {
  return globalAllow === true && slot?.viewOnly !== true;
}

/**
 * When a session that started at [startedAt] must end (ms epoch), or 0 for never: the earlier of the per-session
 * limit and the end of the phone's access.
 */
function sessionDeadline(slot, startedAt) {
  const limit = num(slot?.maxSessionMin) ? startedAt + num(slot.maxSessionMin) * MIN_MS : 0;
  const access = num(slot?.expiresAt);
  if (limit && access) return Math.min(limit, access);
  return limit || access;
}

/** Remaining time as short text: "5 min", "3 h", "2 d". Rounds up so it never shows 0. */
function span(ms) {
  if (ms < HOUR_MS) return `${Math.max(1, Math.ceil(ms / MIN_MS))} min`;
  if (ms < DAY_MS) return `${Math.ceil(ms / HOUR_MS)} h`;
  return `${Math.ceil(ms / DAY_MS)} d`;
}

/** The select option that is closest to (and not shorter than) the remaining access, for showing in the UI. */
function accessPreset(slot, now) {
  const at = num(slot?.expiresAt);
  if (!at) return 'never';
  const left = at - now;
  if (left <= HOUR_MS) return '1h';
  if (left <= DAY_MS) return '1d';
  return '7d';
}

/** What the control panel shows for a phone. */
function describe(slot, now) {
  const viewOnly = slot?.viewOnly === true;
  const expired = isExpired(slot, now);
  const at = num(slot?.expiresAt);
  const parts = [];
  if (viewOnly) parts.push('View only');
  if (expired) parts.push('Access expired');
  else if (at) parts.push(`Access ends in ${span(at - now)}`);
  if (num(slot?.maxSessionMin)) parts.push(`${span(num(slot.maxSessionMin) * MIN_MS)} per session`);
  return { viewOnly, expired, expiresAt: at, access: accessPreset(slot, now), text: parts.join(', ') };
}

/**
 * Applies a control-panel change ({viewOnly?, expiresIn?}) to [slot]. Strict: anything that is not a boolean /
 * one of the four known keys is ignored. Choosing an access length replaces the slot's per-session limit, so a guest
 * that is given "Always" is not still cut off after an hour. Returns whether the slot changed.
 */
function applyUpdate(slot, arg, now) {
  if (!slot || !arg || typeof arg !== 'object') return false;
  let changed = false;
  if (typeof arg.viewOnly === 'boolean' && (slot.viewOnly === true) !== arg.viewOnly) {
    if (arg.viewOnly) slot.viewOnly = true; else delete slot.viewOnly;
    changed = true;
  }
  if (typeof arg.expiresIn === 'string' && Object.prototype.hasOwnProperty.call(EXPIRES_IN, arg.expiresIn)) {
    const ms = EXPIRES_IN[arg.expiresIn];
    slot.expiresAt = ms ? now + ms : 0;
    delete slot.maxSessionMin;
    changed = true;
  }
  return changed;
}

module.exports = { EXPIRES_IN, isExpired, canControl, sessionDeadline, describe, accessPreset, applyUpdate };
