/**
 * Text prefixes of the three things a user may paste: a Grant, an Access key,
 * and a share link. Each parser names the other two when they turn up.
 *
 * @module
 */

/** Text prefix of a group key Grant. Keysmith's CBOR carries its own version. */
export const GRANT_PREFIX = 'fgr1_'

/** Text prefix of an Access key, so both sides refuse a wrong paste and secret scanners find a leak. */
export const ACCESS_KEY_PREFIX = 'fak1_'

/** The fragment prefix of a v1 share link. */
export const SHARE_FRAGMENT_PREFIX = 'v1/'
