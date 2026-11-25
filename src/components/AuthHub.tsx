import React, { useEffect, useState } from 'react';
import {
  ChefHat,
  KeyRound,
  QrCode,
  ShieldCheck,
  Store,
  UtensilsCrossed,
  ArrowRight,
  LogIn,
  Plus,
} from 'lucide-react';
import { signInWithPopup } from 'firebase/auth';
import { auth, googleAuthProvider } from '../lib/firebase';
import { apiFetch, setActiveRestaurantId, setAuthToken } from '../lib/api';
import { AuthContextData, Restaurant } from '../types/dineflow';

interface PublicRestaurant {
  id: number;
  name: string;
  slug: string;
  tagline: string;
  cuisineType: string;
  city: string;
  qrOrderingEnabled: boolean;
  sampleTables: Array<{ id: number; tableNumber: string; section: string }>;
}

interface AuthHubProps {
  onAuthenticated: (payload: {
    auth: AuthContextData;
    restaurants: Restaurant[];
    activeRestaurant: Restaurant | null;
  }) => void;
  onOpenQr: (qrToken: string) => void;
}

export const AuthHub: React.FC<AuthHubProps> = ({ onAuthenticated, onOpenQr }) => {
  const [publicRestaurants, setPublicRestaurants] = useState<PublicRestaurant[]>([]);
  const [loadingPublic, setLoadingPublic] = useState(true);
  const [selectedRestId, setSelectedRestId] = useState<number>(1);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinSubmitting, setPinSubmitting] = useState(false);

  // OTP Staff PIN Recovery state
  const [showPinReset, setShowPinReset] = useState(false);
  const [resetPhone, setResetPhone] = useState('');
  const [resetOtp, setResetOtp] = useState('');
  const [resetNewPin, setResetNewPin] = useState('');
  const [resetVerificationToken, setResetVerificationToken] = useState('');
  const [resetStep, setResetStep] = useState<'request' | 'verify' | 'new_pin'>('request');
  const [resetStatus, setResetStatus] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetLoading, setResetLoading] = useState(false);

  // Manual QR Token launcher state
  const [manualQrInput, setManualQrInput] = useState('');
  const [manualQrError, setManualQrError] = useState('');

  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleError, setGoogleError] = useState('');

  // Onboarding modal/panel after Google Sign-In if user wants to register a new outlet
  const [signedInUser, setSignedInUser] = useState<{
    token: string;
    auth: AuthContextData;
    restaurants: Restaurant[];
  } | null>(null);
  const [showRegisterForm, setShowRegisterForm] = useState(false);
  const [regForm, setRegForm] = useState({
    name: '',
    cuisineType: 'Modern Indian',
    address: '',
    city: 'Bengaluru',
    state: 'Karnataka',
    phone: '',
    gstin: '',
    managerPin: '1234',
  });
  const [regError, setRegError] = useState('');
  const [regSubmitting, setRegSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await apiFetch<{ restaurants: PublicRestaurant[] }>('/public/restaurants');
        if (!active) return;
        setPublicRestaurants(res.restaurants);
        if (res.restaurants.length > 0) {
          setSelectedRestId(res.restaurants[0].id);
        }
      } catch (err) {
        console.error(err);
      } finally {
        if (active) setLoadingPublic(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const handleStaffPinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError('');
    setPinSubmitting(true);
    try {
      const res = await apiFetch<{
        token: string;
        staff: { id: number; name: string; role: AuthContextData['role']; restaurantId: number; permissions: Record<string, boolean> };
        restaurant: Restaurant;
      }>('/auth/staff-login', {
        method: 'POST',
        body: JSON.stringify({ restaurantId: selectedRestId, pin }),
      });

      setAuthToken(res.token);
      setActiveRestaurantId(res.restaurant.id);
      onAuthenticated({
        auth: {
          authType: 'staff',
          displayName: res.staff.name,
          isSuperAdmin: false,
          staffId: res.staff.id,
          role: res.staff.role,
          restaurantId: res.restaurant.id,
          permissions: res.staff.permissions,
        },
        restaurants: [res.restaurant],
        activeRestaurant: res.restaurant,
      });
    } catch (err: any) {
      setPinError(err.message || 'Invalid PIN');
    } finally {
      setPinSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setGoogleError('');
    setGoogleLoading(true);
    try {
      const cred = await signInWithPopup(auth, googleAuthProvider);
      const idToken = await cred.user.getIdToken();
      setAuthToken(idToken);
      const me = await apiFetch<{ auth: AuthContextData; restaurants: Restaurant[] }>('/auth/me');
      if (me.restaurants.length > 0) {
        setSignedInUser({ token: idToken, auth: me.auth, restaurants: me.restaurants });
        // Automatically enter if they only own 1 restaurant and aren't super admin, or let them pick / register
        if (!me.auth.isSuperAdmin && me.restaurants.length === 1) {
          setActiveRestaurantId(me.restaurants[0].id);
          onAuthenticated({
            auth: { ...me.auth, restaurantId: me.restaurants[0].id },
            restaurants: me.restaurants,
            activeRestaurant: me.restaurants[0],
          });
        }
      } else {
        setSignedInUser({ token: idToken, auth: me.auth, restaurants: [] });
        setShowRegisterForm(true);
      }
    } catch (err: any) {
      setGoogleError(err.message || 'Google Sign-In cancelled or failed');
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleEnterRestaurant = (rest: Restaurant | null) => {
    if (!signedInUser) return;
    if (rest) {
      setActiveRestaurantId(rest.id);
    } else {
      setActiveRestaurantId(null);
    }
    onAuthenticated({
      auth: {
        ...signedInUser.auth,
        restaurantId: rest ? rest.id : null,
      },
      restaurants: signedInUser.restaurants,
      activeRestaurant: rest,
    });
  };

  const handleRegisterRestaurant = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegError('');
    setRegSubmitting(true);
    try {
      const res = await apiFetch<{ restaurant: Restaurant }>('/restaurants/register', {
        method: 'POST',
        body: JSON.stringify(regForm),
      });
      if (signedInUser) {
        const updatedList = [...signedInUser.restaurants, res.restaurant];
        setActiveRestaurantId(res.restaurant.id);
        onAuthenticated({
          auth: { ...signedInUser.auth, restaurantId: res.restaurant.id, role: 'owner' },
          restaurants: updatedList,
          activeRestaurant: res.restaurant,
        });
      }
    } catch (err: any) {
      setRegError(err.message || 'Failed to register restaurant');
    } finally {
      setRegSubmitting(false);
    }
  };

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetError('');
    setResetStatus('');
    setResetLoading(true);
    try {
      const res = await apiFetch<{ sent: boolean; expiresInSeconds: number }>('/auth/otp/request', {
        method: 'POST',
        body: JSON.stringify({
          phone: resetPhone,
          purpose: 'staff_reset',
          restaurantId: selectedRestId,
        }),
      });
      if (res.sent) {
        setResetStep('verify');
        setResetStatus(`OTP sent via SMS gateway. Valid for ${Math.round(res.expiresInSeconds / 60)} min.`);
      }
    } catch (err: any) {
      setResetError(err.message || 'Unable to send OTP');
    } finally {
      setResetLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetError('');
    setResetLoading(true);
    try {
      const res = await apiFetch<{ verified: boolean; verificationToken: string }>('/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({
          phone: resetPhone,
          code: resetOtp,
          purpose: 'staff_reset',
        }),
      });
      if (res.verified) {
        setResetVerificationToken(res.verificationToken);
        setResetStep('new_pin');
        setResetStatus('Phone verified. Enter your new 4-6 digit staff PIN.');
      }
    } catch (err: any) {
      setResetError(err.message || 'OTP verification failed');
    } finally {
      setResetLoading(false);
    }
  };

  const handleResetPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetError('');
    setResetLoading(true);
    try {
      await apiFetch('/auth/staff-reset-pin', {
        method: 'POST',
        body: JSON.stringify({
          restaurantId: selectedRestId,
          verificationToken: resetVerificationToken,
          newPin: resetNewPin,
        }),
      });
      setShowPinReset(false);
      setResetStep('request');
      setResetOtp('');
      setResetNewPin('');
      setResetVerificationToken('');
      setResetStatus('');
      setPinError('');
    } catch (err: any) {
      setResetError(err.message || 'Failed to reset PIN');
    } finally {
      setResetLoading(false);
    }
  };

  const handleLaunchQrToken = (e: React.FormEvent) => {
    e.preventDefault();
    setManualQrError('');
    const raw = manualQrInput.trim();
    if (!raw) {
      setManualQrError('Enter or scan a valid table QR token.');
      return;
    }
    let extracted = raw;
    try {
      if (raw.startsWith('http://') || raw.startsWith('https://')) {
        const parsed = new URL(raw);
        extracted = parsed.searchParams.get('qr') || '';
      }
    } catch {
      // treat as raw token
    }
    if (!extracted) {
      setManualQrError('Could not extract ?qr= token from URL.');
      return;
    }
    onOpenQr(extracted);
  };

  const demoPins =
    selectedRestId === publicRestaurants[0]?.id
      ? [
          { label: 'Manager', pin: '1111' },
          { label: 'Waiter', pin: '2222' },
          { label: 'Kitchen', pin: '3333' },
        ]
      : [
          { label: 'Manager', pin: '4444' },
          { label: 'Waiter', pin: '5555' },
          { label: 'Kitchen', pin: '6666' },
        ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* 3-Zone Top Bar Contract */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between gap-8">
        <a href="/" className="text-xl font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
          DineFlow
        </a>
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <a href="#staff-access" className="hover:text-slate-900 whitespace-nowrap shrink-0">Staff Terminal</a>
          <a href="#owner-portal" className="hover:text-slate-900 whitespace-nowrap shrink-0">Owner Portal</a>
          <a href="#qr-ordering" className="hover:text-slate-900 whitespace-nowrap shrink-0">Table QR Menu</a>
        </nav>
        <div className="shrink-0">
          <button
            onClick={handleGoogleSignIn}
            disabled={googleLoading}
            className="px-4 py-2 text-sm font-medium text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-2 cursor-pointer disabled:opacity-60"
          >
            <LogIn className="w-4 h-4" />
            {googleLoading ? 'Signing in...' : 'Owner Sign-In'}
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-10 space-y-10">
        {/* Compact Intro Heading */}
        <section className="max-w-3xl space-y-3">
          <p className="text-sm font-medium text-orange-600">
            Multi-Tenant Restaurant Operating System
          </p>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
            The Operating System for Modern Restaurants
          </h1>
          <p className="text-base text-slate-600 leading-relaxed">
            Unify table QR ordering, live kitchen displays, waiter floor operations, GST billing, recipe inventory, and multi-outlet analytics on one isolated PostgreSQL platform.
          </p>
        </section>

        {/* Signed-in Workspace Selector / Onboarding */}
        {signedInUser && (
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  Welcome, {signedInUser.auth.displayName}
                </h2>
                <p className="text-sm text-slate-500">
                  {signedInUser.auth.email} · {signedInUser.auth.isSuperAdmin ? 'Platform Super Admin' : 'Restaurant Owner'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {signedInUser.auth.isSuperAdmin && (
                  <button
                    onClick={() => handleEnterRestaurant(null)}
                    className="px-4 py-2 text-sm font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-2 cursor-pointer whitespace-nowrap"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    Open Super Admin
                  </button>
                )}
                <button
                  onClick={() => setShowRegisterForm((v) => !v)}
                  className="px-4 py-2 text-sm font-medium border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-4 h-4" />
                  Register New Restaurant
                </button>
              </div>
            </div>

            {showRegisterForm ? (
              <form onSubmit={handleRegisterRestaurant} className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Restaurant Name</label>
                  <input
                    required
                    value={regForm.name}
                    onChange={(e) => setRegForm({ ...regForm, name: e.target.value })}
                    placeholder="e.g. Dakshin Table"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Cuisine Type</label>
                  <input
                    value={regForm.cuisineType}
                    onChange={(e) => setRegForm({ ...regForm, cuisineType: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Street Address</label>
                  <input
                    required
                    value={regForm.address}
                    onChange={(e) => setRegForm({ ...regForm, address: e.target.value })}
                    placeholder="12th Main Road, Indiranagar"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">City</label>
                  <input
                    required
                    value={regForm.city}
                    onChange={(e) => setRegForm({ ...regForm, city: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Phone Number</label>
                  <input
                    required
                    value={regForm.phone}
                    onChange={(e) => setRegForm({ ...regForm, phone: e.target.value })}
                    placeholder="+91 98450 00000"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">GSTIN (Optional)</label>
                  <input
                    value={regForm.gstin}
                    onChange={(e) => setRegForm({ ...regForm, gstin: e.target.value })}
                    placeholder="29ABCDE1234F1Z5"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 font-mono-num"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Initial Owner Staff PIN</label>
                  <input
                    required
                    minLength={4}
                    maxLength={6}
                    value={regForm.managerPin}
                    onChange={(e) => setRegForm({ ...regForm, managerPin: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 font-mono-num"
                  />
                </div>
                {regError && <p className="md:col-span-2 text-sm text-red-600">{regError}</p>}
                <div className="md:col-span-2 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setShowRegisterForm(false)}
                    className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={regSubmitting}
                    className="px-5 py-2 text-sm font-medium bg-orange-600 text-white rounded-lg hover:bg-orange-700 cursor-pointer"
                  >
                    {regSubmitting ? 'Creating Outlet...' : 'Create Restaurant Workspace'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {signedInUser.restaurants.map((rest) => (
                  <button
                    key={rest.id}
                    onClick={() => handleEnterRestaurant(rest)}
                    className="text-left p-4 rounded-xl border border-slate-200 hover:border-orange-500 hover:bg-orange-50/40 transition-colors flex items-center justify-between gap-4 cursor-pointer"
                  >
                    <div>
                      <div className="font-semibold text-slate-900">{rest.name}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {rest.city} · {rest.cuisineType} · {rest.subscriptionStatus}
                      </div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-orange-600 shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Two Main Auth Workspaces */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
          {/* Staff PIN Terminal */}
          <section id="staff-access" className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between">
            <div className="space-y-5">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Staff Floor & Kitchen PIN</h2>
                  <p className="text-sm text-slate-500 mt-0.5">
                    Fast shift sign-in for Managers, Waiters, and Kitchen Display staff.
                  </p>
                </div>
                <KeyRound className="w-5 h-5 text-orange-600 shrink-0" />
              </div>

              <form onSubmit={handleStaffPinSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Select Outlet</label>
                  {loadingPublic ? (
                    <div className="h-10 bg-slate-100 animate-pulse rounded-lg" />
                  ) : (
                    <select
                      value={selectedRestId}
                      onChange={(e) => setSelectedRestId(Number(e.target.value))}
                      className="w-full px-3 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                    >
                      {publicRestaurants.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} — {r.city}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Staff PIN</label>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    placeholder="Enter 4-digit PIN"
                    className="w-full px-3 py-2.5 text-sm font-mono-num tracking-widest border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                    required
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-xs text-slate-500">Quick PIN fill:</span>
                  {demoPins.map((dp) => (
                    <button
                      key={dp.pin}
                      type="button"
                      onClick={() => setPin(dp.pin)}
                      className="px-2.5 py-1 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md transition-colors cursor-pointer"
                    >
                      {dp.label} ({dp.pin})
                    </button>
                  ))}
                </div>

                {pinError && <p className="text-sm text-red-600">{pinError}</p>}

                <button
                  type="submit"
                  disabled={pinSubmitting || loadingPublic}
                  className="w-full py-2.5 px-4 text-sm font-medium bg-slate-900 hover:bg-slate-800 text-white rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                >
                  {pinSubmitting ? 'Verifying PIN...' : 'Enter Staff Workspace'}
                </button>
              </form>

              <div className="pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => {
                    setShowPinReset((v) => !v);
                    setResetError('');
                    setResetStatus('');
                  }}
                  className="text-xs font-medium text-orange-600 hover:underline cursor-pointer"
                >
                  {showPinReset ? 'Back to PIN Sign-In' : 'Forgot Staff PIN? Reset via OTP'}
                </button>

                {showPinReset && (
                  <div className="mt-3 p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
                    {resetStep === 'request' && (
                      <form onSubmit={handleRequestOtp} className="space-y-2.5">
                        <label className="block text-xs font-medium text-slate-700">
                          Registered Staff Mobile Number
                        </label>
                        <input
                          required
                          value={resetPhone}
                          onChange={(e) => setResetPhone(e.target.value)}
                          placeholder="+91 98450 00000"
                          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                        />
                        <button
                          type="submit"
                          disabled={resetLoading}
                          className="w-full py-2 text-xs font-semibold bg-orange-600 text-white rounded-lg hover:bg-orange-700 cursor-pointer disabled:opacity-50"
                        >
                          {resetLoading ? 'Sending OTP...' : 'Send Verification OTP'}
                        </button>
                      </form>
                    )}
                    {resetStep === 'verify' && (
                      <form onSubmit={handleVerifyOtp} className="space-y-2.5">
                        <label className="block text-xs font-medium text-slate-700">
                          Enter 6-digit OTP
                        </label>
                        <input
                          required
                          maxLength={6}
                          inputMode="numeric"
                          value={resetOtp}
                          onChange={(e) => setResetOtp(e.target.value)}
                          placeholder="6-digit OTP"
                          className="w-full px-3 py-2 text-xs font-mono-num border border-slate-300 rounded-lg bg-white"
                        />
                        <button
                          type="submit"
                          disabled={resetLoading}
                          className="w-full py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                        >
                          {resetLoading ? 'Verifying...' : 'Verify OTP'}
                        </button>
                      </form>
                    )}
                    {resetStep === 'new_pin' && (
                      <form onSubmit={handleResetPin} className="space-y-2.5">
                        <label className="block text-xs font-medium text-slate-700">
                          New 4-6 Digit Staff PIN
                        </label>
                        <input
                          required
                          type="password"
                          minLength={4}
                          maxLength={6}
                          inputMode="numeric"
                          value={resetNewPin}
                          onChange={(e) => setResetNewPin(e.target.value)}
                          placeholder="Enter new PIN"
                          className="w-full px-3 py-2 text-xs font-mono-num border border-slate-300 rounded-lg bg-white"
                        />
                        <button
                          type="submit"
                          disabled={resetLoading}
                          className="w-full py-2 text-xs font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 cursor-pointer disabled:opacity-50"
                        >
                          {resetLoading ? 'Saving PIN...' : 'Save New PIN'}
                        </button>
                      </form>
                    )}
                    {resetStatus && <p className="text-xs text-emerald-700">{resetStatus}</p>}
                    {resetError && <p className="text-xs text-red-600">{resetError}</p>}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Owner / Admin Google Sign-In */}
          <section id="owner-portal" className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-6">
            <div className="space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Owner & Platform Admin</h2>
                  <p className="text-sm text-slate-500 mt-0.5">
                    Sign in with Google to access full P&L analytics, GST settings, staff permissions, or register a new restaurant.
                  </p>
                </div>
                <Store className="w-5 h-5 text-orange-600 shrink-0" />
              </div>

              <div className="divide-y divide-slate-100 border-t border-b border-slate-100 text-sm">
                <div className="py-3 flex items-center justify-between">
                  <span className="text-slate-600">Isolated Multi-Tenant PostgreSQL</span>
                  <span className="font-medium text-slate-900">Enforced</span>
                </div>
                <div className="py-3 flex items-center justify-between">
                  <span className="text-slate-600">New Restaurant Onboarding</span>
                  <span className="font-medium text-slate-900">Self-Service</span>
                </div>
                <div className="py-3 flex items-center justify-between">
                  <span className="text-slate-600">Platform Super Admin</span>
                  <span className="font-medium text-slate-900">Verified Accounts</span>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              {googleError && <p className="text-sm text-red-600">{googleError}</p>}
              <button
                onClick={handleGoogleSignIn}
                disabled={googleLoading}
                className="w-full py-2.5 px-4 text-sm font-medium bg-orange-600 hover:bg-orange-700 text-white rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <LogIn className="w-4 h-4" />
                {googleLoading ? 'Connecting Google Account...' : 'Continue with Google Sign-In'}
              </button>
            </div>
          </section>
        </div>

        {/* Customer QR Ordering Live Table Access */}
        <section id="qr-ordering" className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Customer Table QR Ordering</h2>
              <p className="text-sm text-slate-500 mt-0.5">
                Scan a table QR standee or enter a valid table QR token issued by the outlet to launch your dine-in session.
              </p>
            </div>
            <QrCode className="w-5 h-5 text-orange-600 shrink-0" />
          </div>

          <form onSubmit={handleLaunchQrToken} className="flex flex-col sm:flex-row gap-2.5">
            <input
              value={manualQrInput}
              onChange={(e) => setManualQrInput(e.target.value)}
              placeholder="Paste table QR token (e.g. dfqr_...) or scanned QR link"
              className="flex-1 px-3.5 py-2.5 text-sm font-mono-num border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <button
              type="submit"
              className="px-5 py-2.5 text-sm font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-lg cursor-pointer whitespace-nowrap"
            >
              Open Table Menu
            </button>
          </form>
          {manualQrError && <p className="text-xs text-red-600">{manualQrError}</p>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {publicRestaurants.map((rest) => (
              <div key={rest.id} className="border border-slate-200 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-slate-900">{rest.name}</h3>
                    <p className="text-xs text-slate-500">
                      {rest.city} · {rest.cuisineType}
                    </p>
                  </div>
                  <UtensilsCrossed className="w-4 h-4 text-slate-400" />
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  {rest.sampleTables.map((tbl) => (
                    <span
                      key={tbl.id}
                      className="px-3 py-1.5 text-xs font-medium bg-slate-50 text-slate-700 border border-slate-200 rounded-lg flex items-center gap-1.5"
                    >
                      <QrCode className="w-3.5 h-3.5 text-orange-600" />
                      Table {tbl.tableNumber} · {tbl.section}
                    </span>
                  ))}
                </div>
                <p className="text-[11px] text-slate-500">
                  Table QR access tokens are cryptographically protected. Staff can view, print, revoke, or regenerate table QRs in Tables & QR.
                </p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white px-6 py-4 text-xs text-slate-500 flex items-center justify-between max-w-full">
        <span>DineFlow Hospitality Systems</span>
        <span className="flex items-center gap-1.5">
          <ChefHat className="w-3.5 h-3.5 text-orange-600" />
          Multi-Outlet Operations · GST Ready
        </span>
      </footer>
    </div>
  );
};
