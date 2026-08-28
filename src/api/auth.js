'use strict';
/**
 * src/api/auth.js
 *
 * Middleware and helpers for API key authentication.
 *
 * Clients send their key in ONE of these ways (checked in order):
 *   1. Authorization: Bearer <key>
 *   2. X-Api-Key: <key>
 *   3. ?api_key=<key>  (query string – handy for quick browser tests)
 */

const db = require('../db');

/** Extract the raw key string from the request (returns null if absent). */
function extractRawKey(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();

  const header = req.headers['x-api-key'];
  if (header) return header.trim();

  if (req.query.api_key) return req.query.api_key.trim();

  return null;
}

/**
 * requireAuth(role?)
 *
 * Middleware factory.  role is optional; if supplied the principal must have
 * that role (or 'admin', which can do everything).
 *
 * On success attaches req.principal = { id, label, role, clubIds }
 *   clubIds = []   → unrestricted (all clubs)
 *   clubIds = […]  → restricted to those club IDs
 */
function requireAuth(role) {
  return (req, res, next) => {
    const rawKey = extractRawKey(req);
    if (!rawKey) {
      return res.status(401).json({
        ok: false,
        error: 'API key required. Supply via Authorization: Bearer <key>, X-Api-Key header, or ?api_key= query param.',
      });
    }

    const principal = db.resolveApiKey(req.app.locals.db, rawKey);
    if (!principal) {
      return res.status(401).json({ ok: false, error: 'Invalid or revoked API key.' });
    }

    if (role && principal.role !== role && principal.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: `This endpoint requires the '${role}' role.`,
      });
    }

    req.principal = principal;
    next();
  };
}

/** Middleware that requires admin role. */
const requireAdmin = requireAuth('admin');

/** Middleware that requires any valid key (reader or admin). */
const requireReader = requireAuth();

module.exports = { requireAuth, requireAdmin, requireReader, extractRawKey };
