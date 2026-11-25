import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUNTIME_SESSION_SECRET =
  process.env.SESSION_SIGNING_SECRET && process.env.SESSION_SIGNING_SECRET.length >= 16
    ? process.env.SESSION_SIGNING_SECRET
    : crypto.randomBytes(32).toString('hex');

const RUNTIME_RAZORPAY_SECRET =
  process.env.RAZORPAY_TEST_SECRET && process.env.RAZORPAY_TEST_SECRET.length >= 16
    ? process.env.RAZORPAY_TEST_SECRET
    : crypto.randomBytes(32).toString('hex');

export const UPLOADS_RECEIPTS_DIR = path.resolve(process.cwd(), 'uploads', 'receipts');
export const UPLOADS_LOGOS_DIR = path.resolve(process.cwd(), 'uploads', 'logos');

export const QR_TOKEN_TTL_DAYS = 30;
export const STAFF_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const QR_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
export const QR_INACTIVITY_TTL_MS = 30 * 60 * 1000;
export const CUSTOMER_PIN_MAX_ATTEMPTS = 3;
export const CUSTOMER_PIN_LOCKOUT_MS = 2 * 60 * 1000;
export const ORDER_AUTH_TOKEN_TTL_MS = 5 * 60 * 1000;
export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const STAFF_MAX_FAILED_ATTEMPTS = 5;
export const STAFF_LOCKOUT_MS = 15 * 60 * 1000;

const PIN_AES_KEY = crypto
  .createHash('sha256')
  .update(
    process.env.PIN_ENCRYPTION_SECRET && process.env.PIN_ENCRYPTION_SECRET.length >= 16
      ? process.env.PIN_ENCRYPTION_SECRET
      : RUNTIME_SESSION_SECRET,
  )
  .digest();

export function hashPin(pin: string, existingSalt?: string): { hash: string; salt: string } {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(pin, salt, 64).toString('hex');
  return { hash: derived, salt };
}

export function verifyPin(pin: string, storedHash: string, salt: string): boolean {
  if (!pin || !storedHash || !salt) return false;
  const { hash } = hashPin(pin, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const hashSecret = hashPin;
export const verifySecret = verifyPin;

export function generateSecureQrToken(): string {
  return `dfqr_${crypto.randomBytes(24).toString('base64url')}`;
}

export function isCryptographicQrToken(token: string): boolean {
  return typeof token === 'string' && token.startsWith('dfqr_') && token.length >= 36;
}

export function hashTokenSha256(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateOtpCode(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

export function generateDiningPin(): string {
  return crypto.randomInt(0, 1000).toString().padStart(3, '0');
}

export function generateDiningSessionUid(): string {
  return `ds_${crypto.randomBytes(10).toString('base64url')}`;
}

export function generateQrSessionUid(): string {
  return `qrs_${crypto.randomBytes(12).toString('base64url')}`;
}

export function generateOrderAuthJti(): string {
  return `oat_${crypto.randomBytes(12).toString('base64url')}`;
}

export function encryptDiningPin(pin: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', PIN_AES_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('hex')}.${tag.toString('hex')}.${encrypted.toString('hex')}`;
}

export function decryptDiningPin(payload: string | null | undefined): string | null {
  if (!payload || typeof payload !== 'string') return null;
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const iv = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    const encrypted = Buffer.from(parts[3], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', PIN_AES_KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    return /^\d{3}$/.test(decrypted) ? decrypted : null;
  } catch {
    return null;
  }
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

export function normalizePhone(raw: unknown): string {
  const cleaned = String(raw || '').trim().replace(/[\s\-().]/g, '');
  if (!/^\+?[0-9]{8,15}$/.test(cleaned)) return '';
  return cleaned;
}

export function sanitizeText(raw: unknown, maxLen = 250): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export interface StaffTokenPayload {
  kind: 'staff';
  jti: string;
  staffId: number;
  restaurantId: number;
  role: string;
  name: string;
  tv: number;
  exp: number;
}

export interface QrTokenPayload {
  kind: 'qr';
  qsid: string;
  dsid: number;
  tableId: number;
  restaurantId: number;
  qrToken: string;
  tv: number;
  exp: number;
}

export interface OrderAuthTokenPayload {
  kind: 'order_auth';
  jti: string;
  qsid: string;
  dsid: number;
  tableId: number;
  restaurantId: number;
  exp: number;
}

export interface OtpProofPayload {
  kind: 'otp_proof';
  phone: string;
  purpose: string;
  restaurantId: number | null;
  exp: number;
}

export type SignedTokenPayload =
  | StaffTokenPayload
  | QrTokenPayload
  | OrderAuthTokenPayload
  | OtpProofPayload;

export function signAppToken(payload: SignedTokenPayload): string {
  const prefix =
    payload.kind === 'staff'
      ? 'df_staff'
      : payload.kind === 'qr'
      ? 'df_qr'
      : payload.kind === 'order_auth'
      ? 'df_oa'
      : 'df_otp';
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', RUNTIME_SESSION_SECRET)
    .update(`${prefix}.${body}`)
    .digest('base64url');
  return `${prefix}.${body}.${sig}`;
}

export function verifyAppToken(token: string): SignedTokenPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [prefix, body, sig] = parts;
  if (prefix !== 'df_staff' && prefix !== 'df_qr' && prefix !== 'df_oa' && prefix !== 'df_otp') {
    return null;
  }

  const expectedSig = crypto
    .createHmac('sha256', RUNTIME_SESSION_SECRET)
    .update(`${prefix}.${body}`)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedTokenPayload;
    if (!parsed.exp || Date.now() > parsed.exp) return null;
    if (prefix === 'df_staff' && parsed.kind !== 'staff') return null;
    if (prefix === 'df_qr' && parsed.kind !== 'qr') return null;
    if (prefix === 'df_oa' && parsed.kind !== 'order_auth') return null;
    if (prefix === 'df_otp' && parsed.kind !== 'otp_proof') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function generateRazorpayTestSignature(razorpayOrderId: string, razorpayPaymentId: string): string {
  return crypto
    .createHmac('sha256', RUNTIME_RAZORPAY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
}

export function verifyRazorpayTestSignature(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  signature: string,
): boolean {
  if (!signature) return false;
  const expected = generateRazorpayTestSignature(razorpayOrderId, razorpayPaymentId);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function verifyRazorpayWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function resolveSafeReceiptPath(filename: string): string | null {
  if (!filename || !/^[a-zA-Z0-9._-]+$/.test(filename)) {
    return null;
  }
  const baseName = path.basename(filename);
  const resolved = path.resolve(UPLOADS_RECEIPTS_DIR, baseName);
  if (!resolved.startsWith(UPLOADS_RECEIPTS_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

export function resolveSafeLogoPath(filename: string): string | null {
  if (!filename || !/^[a-zA-Z0-9._-]+$/.test(filename)) {
    return null;
  }
  const baseName = path.basename(filename);
  const resolved = path.resolve(UPLOADS_LOGOS_DIR, baseName);
  if (!resolved.startsWith(UPLOADS_LOGOS_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

export function sanitizeLogoUrl(raw: unknown): string {
  const val = String(raw ?? '').trim().slice(0, 400);
  if (!val) return '';
  if (/^\/api\/uploads\/logos\/[a-zA-Z0-9._-]+$/.test(val)) {
    return val;
  }
  try {
    const parsed = new URL(val);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
    return '';
  } catch {
    return '';
  }
}

export function validateReceiptMagicBytes(filePath: string): { valid: boolean; detectedType: string } {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    const bytesRead = fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);

    if (bytesRead < 4) return { valid: false, detectedType: 'unknown' };

    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { valid: true, detectedType: 'image/png' };
    }
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return { valid: true, detectedType: 'image/jpeg' };
    }
    // WEBP: RIFF....WEBP
    if (
      bytesRead >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return { valid: true, detectedType: 'image/webp' };
    }
    // PDF: %PDF
    if (buf.subarray(0, 4).toString('ascii') === '%PDF') {
      return { valid: true, detectedType: 'application/pdf' };
    }

    return { valid: false, detectedType: 'unknown' };
  } catch {
    return { valid: false, detectedType: 'error' };
  }
}

export class SlidingWindowLimiter {
  private buckets = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  consume(key: string): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = (this.buckets.get(key) || []).filter((ts) => ts > cutoff);

    if (timestamps.length >= this.maxRequests) {
      const oldest = timestamps[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      this.buckets.set(key, timestamps);
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    timestamps.push(now);
    this.buckets.set(key, timestamps);

    // Prevent unbounded memory growth
    if (this.buckets.size > 10000) {
      for (const [k, list] of this.buckets.entries()) {
        if (list.length === 0 || list[list.length - 1] <= cutoff) {
          this.buckets.delete(k);
        }
      }
    }

    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - timestamps.length),
      retryAfterSeconds: 0,
    };
  }

  reset(key: string) {
    this.buckets.delete(key);
  }
}
