/** Native-host compatibility floor baked into THIS extension build.
 *
 *  Release checklist: when the extension starts to depend on a newer host, publish
 *  that host to npm first, then bump MIN_HOST_VERSION here and ship the extension.
 *  Deliberately NOT auto-synced to apps/host/package.json — an extension build may
 *  intentionally target a slightly older host. */

/** Minimum host version this extension build works with. A host >= this is left
 *  untouched; an older host is silently upgraded to exactly this version
 *  (upgrade-only — we never downgrade a newer host). */
export const MIN_HOST_VERSION = '0.1.19';

/** First host version that understands the `host:update` message. Pinned forever
 *  at that floor — any host >= this can be told to self-update. A host below it
 *  (all pre-0.1.15 hosts report a stale '0.1.0' stub, and a broken version read
 *  reports '0.0.0') cannot self-update and must be updated manually. */
export const SELF_UPDATE_MIN_VERSION = '0.1.15';
