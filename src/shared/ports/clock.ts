/**
 * The only source of "now" the pure layer may use (R7). A use case that calls
 * `new Date()` cannot be tested at a boundary — and the refresh rotation is
 * all boundaries: expiry, and a 30 second grace window.
 */
export interface IClock {
  now(): Date
}
