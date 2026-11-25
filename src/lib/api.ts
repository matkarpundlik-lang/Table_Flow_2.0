// Memory-only token store (never stored in localStorage/sessionStorage)
let memoryAuthToken: string | null = null;
let activeRestaurantId: number | null = null;

export function setAuthToken(token: string | null) {
  memoryAuthToken = token;
}

export function getAuthToken(): string | null {
  return memoryAuthToken;
}

export function setActiveRestaurantId(id: number | null) {
  activeRestaurantId = id;
}

export function getActiveRestaurantId(): number | null {
  return activeRestaurantId;
}

export async function apiFetch<T = any>(
  path: string,
  options: RequestInit & { restaurantIdOverride?: number | null } = {},
): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (memoryAuthToken) {
    headers.set('Authorization', `Bearer ${memoryAuthToken}`);
  }
  const restId =
    options.restaurantIdOverride !== undefined ? options.restaurantIdOverride : activeRestaurantId;
  if (restId) {
    headers.set('x-restaurant-id', String(restId));
  }
  if (!(options.body instanceof FormData) && !headers.has('Content-Type') && options.method && options.method !== 'GET') {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`/api${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    let errMessage = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) errMessage = data.error;
    } catch {
      // ignore json parse failure
    }
    throw new Error(errMessage);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json() as Promise<T>;
  }
  return (await res.text()) as unknown as T;
}

export function formatInr(amount: number | null | undefined): string {
  const val = Number(amount || 0);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: val % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(val);
}

export function formatElapsedMinutes(isoDate: string): { mins: number; label: string } {
  const diffMs = Math.max(0, Date.now() - new Date(isoDate).getTime());
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return { mins: 0, label: 'Just now' };
  if (mins < 60) return { mins, label: `${mins}m` };
  const hrs = Math.floor(mins / 60);
  return { mins, label: `${hrs}h ${mins % 60}m` };
}

export function playKitchenChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const freqs = [587.33, 880]; // D5 -> A5 pleasant service bell chime
    freqs.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, now + idx * 0.12);
      gain.gain.setValueAtTime(0.001, now + idx * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.16, now + idx * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.12);
      osc.stop(now + idx * 0.12 + 0.38);
    });
  } catch {
    // Audio playback blocked before gesture
  }
}

export function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idem_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

export async function fetchAuthorizedBlobUrl(apiOrAbsolutePath: string): Promise<{
  blobUrl: string;
  contentType: string;
}> {
  const headers = new Headers();
  if (memoryAuthToken) {
    headers.set('Authorization', `Bearer ${memoryAuthToken}`);
  }
  if (activeRestaurantId) {
    headers.set('x-restaurant-id', String(activeRestaurantId));
  }

  const res = await fetch(apiOrAbsolutePath, { headers });
  if (!res.ok) {
    let errMessage = `Unable to load file (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) errMessage = data.error;
    } catch {
      // ignore json parse failure
    }
    throw new Error(errMessage);
  }
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const blob = await res.blob();
  return {
    blobUrl: URL.createObjectURL(blob),
    contentType,
  };
}

