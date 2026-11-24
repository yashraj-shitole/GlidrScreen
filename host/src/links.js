'use strict';
// glidr-screen:// automation links. Three verbs only, and nothing that starts a share or a pairing:
//   glidr-screen://pause   glidr-screen://resume   glidr-screen://disconnect
// Anything else (other verbs, paths, queries, fragments, credentials, other schemes) is rejected.

const SCHEME = 'glidr-screen';
const VERBS = ['pause', 'resume', 'disconnect'];
const LINK = new RegExp(`^${SCHEME}://(${VERBS.join('|')})/?$`, 'i');

/** @returns {'pause'|'resume'|'disconnect'|null} */
function parseLink(url) {
  if (typeof url !== 'string' || url.length > 64) return null;
  const m = LINK.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

/** First valid automation link in a command line, or null. Other arguments are ignored. */
function findLink(argv) {
  for (const a of argv || []) {
    const verb = parseLink(a);
    if (verb) return verb;
  }
  return null;
}

/** Whether an argument looks like one of our links at all (valid or not): used to keep a stray link from opening the UI. */
function isLinkArg(a) { return typeof a === 'string' && a.toLowerCase().startsWith(`${SCHEME}:`); }

/**
 * Runs the verb of [url] through [actions] ({pause, resume, disconnect}). Returns the verb, or null if rejected.
 */
function handleLink(url, actions) {
  const verb = parseLink(url);
  if (!verb) return null;
  actions[verb]();
  return verb;
}

module.exports = { SCHEME, VERBS, parseLink, findLink, isLinkArg, handleLink };
