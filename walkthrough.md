# DineFlow Security Upgrade Walkthrough

# Security Summary

We completed a full-stack security upgrade across the DineFlow frontend, Express APIs, session & OTP controls, QR table access system, ordering & payment flows, and Cloud SQL PostgreSQL schema—without resetting or deleting any existing restaurant, table, menu, or staff records.

### Key Protections Added

- **Authentication, Brute-Force Protection & Session Revocation**:
  - Staff PIN logins now enforce sliding-window rate limiting and automatic 15-minute lockout after 5 failed attempts.
  - All staff tokens carry a unique session ID (`jti`) backed by the PostgreSQL `user_sessions` table and a staff `tokenVersion`, enabling immediate revocation on sign-out (`POST /api/auth/logout`), logout-all (`POST /api/auth/logout-all`), PIN reset, permission downgrade, or Owner revocation.
  - OTP verification (`POST /api/auth/otp/request`, `/api/auth/otp/verify`, `/api/auth/staff-reset-pin`) hashes 6-digit codes with `scrypt` + per-challenge salt, enforces a 5-minute TTL, 60-second resend cooldown, max 3 requests per 10 minutes, max 5 verification attempts, atomic single-use consumption, and real SMS gateway delivery via Twilio or a configured webhook (returning `503` if unconfigured rather than simulating OTP success).
- **Cryptographic Table QR Access & Revocation**:
  - Replaced predictable starter QR tokens with 24-byte CSPRNG `dfqr_` tokens with 30-day expiry policies, and removed raw `qrToken` values from public discovery (`GET /api/public/restaurants`).
  - Every customer QR action (live SSE stream, placing orders, waiter/bill requests, feedback) validates an HMAC-signed `x-qr-session` token bound to the specific table ID, restaurant ID, and `qrTokenVersion`, rejecting cross-table tampering (`403`) or mismatched sessions (`401`).
  - Added `POST /api/tables/:id/qr/revoke` and `POST /api/tables/:id/qr/regenerate` with full lifecycle tracking in `qr_token_history` and controls directly inside **Tables & QR**.
- **Authoritative Order, Idempotency & Payment Integrity**:
  - Server-side `buildAuthoritativeOrderItems` and `computeOrderTotals` strictly recompute item prices, variant/addon deltas, promo discounts, GST, and service charges from database records, rejecting invalid quantities (`<= 0` or `> 50`) and stripping unauthorized manual discounts on QR orders.
  - Enforced `idempotencyKey` uniqueness per restaurant (`orders_rest_idemp_uidx`) to block duplicate order submissions (`409`).
  - Enforced an explicit order state machine (`ALLOWED_ORDER_TRANSITIONS`), blocked direct `PATCH /orders/:id/status` transitions to `Paid` (`403`), enforced server-side Razorpay signature verification (`POST /api/webhooks/razorpay` & `/orders/:id/razorpay/verify`) with replay protection, and blocked production test-mode bypasses.
- **Role-Based Access Control, File Upload Hardening & Security Monitoring**:
  - Restricted financial, receipt, QR rotation, and security routes to authorized roles (`manage_billing`, `manage_expenses`, `manage_inventory`, `manage_tables`, `manage_staff`, `isSuperAdmin`) and strict `restaurantId` tenant isolation.
  - Validated uploaded receipts by binary magic bytes (`PNG`, `JPEG`, `WEBP`, `PDF`) and moved receipt downloads behind authenticated, tenant-scoped `GET /api/uploads/receipts/:filename` with an inline modal viewer in **Expenses**.
  - Added HTTP security headers (while preserving iframe previews and Google Sign-In popups), strict same-origin CORS, a 1MB JSON payload cap, safe error responses, and the **Security Activity** view backed by `security_events` and `user_sessions`.

## PoC Verification

All 14 security verification tests were executed live against the upgraded server (`http://127.0.0.1:3000`) and Cloud SQL PostgreSQL database:

1. **Brute-Force Lockout (`POST /api/auth/staff-login`)**: 5 wrong PIN attempts triggered `401` x4 -> `423 Locked`; subsequent valid PIN while locked returned `423`.
2. **Unauthenticated Access**: Requests without bearer tokens to `/api/orders`, `/api/payments`, and `/api/security/overview` returned `401`.
3. **Session Logout Revocation**: Calling `POST /api/auth/logout` immediately invalidated the token; reusing it returned `401 Session has been logged out or expired`.
4. **Role-Based Access Control**: Manager calling `/api/super-admin/overview` and `/api/security/overview` returned `403`; Kitchen calling `/api/payments`, `/api/expenses`, `/api/security/overview`, and `/api/tables/:id/qr/revoke` returned `403`.
5. **Cross-Tenant Isolation**: Restaurant 1 Manager passing `x-restaurant-id: 2` returned `403 Cross-restaurant access denied`.
6. **QR Token Unpredictability**: Verified all 15 database tables use CSPRNG `dfqr_` tokens; legacy `spice-t01` and bogus tokens returned `401`.
7. **QR Session & Table Tampering**: Missing `x-qr-session` (`401`), swapping Table A's session onto Table B (`401`), and tampering `body.tableId` / `body.restaurantId` (`403`) were all blocked.
8. **QR Revocation & Regeneration**: Revoking a table QR blocked scans (`401`); regenerating issued a fresh `dfqr_` token (`200`) while keeping the old token rejected (`401`).
9. **Price & Quantity Tampering**: Negative quantity (`-5`) returned `400`; manipulated item price (`1`) and `manualDiscountAmount: 99999` on QR orders were ignored in favor of authoritative DB prices (`₹445` subtotal, `₹489.5` total).
10. **OTP Enforcement**: Live unconfigured SMS delivery returned `503` (never simulated); testing against an authenticated local webhook verified 60s resend cooldown (`429`), 5 wrong attempts lockout (`429`), valid verification (`200`), and single-use replay rejection (`400`).
11. **Duplicate Order Idempotency**: Re-submitting an identical `x-idempotency-key` returned `409 Duplicate order submission blocked`.
12. **Order State Machine & Unpaid Protection**: Setting `status: "Paid"` directly returned `403`; jumping `New -> Closed` returned `409`.
13. **File Upload & Receipt Isolation**: Uploading a shell script disguised as `.png` failed magic-byte validation (`400`); a valid PNG receipt blocked unauthenticated download (`401`), blocked cross-tenant download (`403`), and allowed the owning outlet (`200`).
14. **Security Monitoring & Session Control**: `GET /api/security/overview` returned recorded security events and `qr_token_history` rows; Owner revocation via `POST /api/security/sessions/:id/revoke` immediately blocked the active Waiter token (`401`).
