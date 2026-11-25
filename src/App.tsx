import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  ChefHat,
  ClipboardList,
  FileText,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Receipt,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
  Users,
  UserCheck,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import { signOut } from 'firebase/auth';
import { auth } from './lib/firebase';
import {
  apiFetch,
  getAuthToken,
  playKitchenChime,
  setActiveRestaurantId,
  setAuthToken,
} from './lib/api';
import { AuthContextData, Restaurant } from './types/dineflow';
import { AuthHub } from './components/AuthHub';
import { CustomerQrPortal } from './components/CustomerQrPortal';
import { OwnerDashboardView } from './components/OwnerDashboardView';
import { KitchenDisplay } from './components/KitchenDisplay';
import { TablesAndQrView } from './components/TablesAndQrView';
import { OrdersAndPosView } from './components/OrdersAndPosView';
import { MenuManagementView } from './components/MenuManagementView';
import { InventoryView } from './components/InventoryView';
import { ExpensesView } from './components/ExpensesView';
import { CustomersAndStaffView } from './components/CustomersAndStaffView';
import { AnalyticsView, SettingsView } from './components/AnalyticsAndSettingsView';
import { SuperAdminView } from './components/SuperAdminView';
import { SecurityView } from './components/SecurityView';
import { CustomerOrderSecurityView } from './components/CustomerOrderSecurityView';
import { BillingHistoryView } from './components/BillingHistoryView';
import { BillingSettingsView } from './components/BillingSettingsView';

export default function App() {
  const [qrToken, setQrToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('qr');
  });

  const [session, setSession] = useState<{
    auth: AuthContextData;
    restaurants: Restaurant[];
    activeRestaurant: Restaurant | null;
  } | null>(null);

  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [toast, setToast] = useState('');
  const [posTableId, setPosTableId] = useState<number | null>(null);

  const pushToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 4000);
  };

  // Real-time SSE connection for active restaurant
  useEffect(() => {
    const rest = session?.activeRestaurant;
    const token = getAuthToken();
    if (!rest || !token) return;

    const es = new EventSource(
      `/api/realtime/stream?token=${encodeURIComponent(token)}&restaurantId=${rest.id}`,
    );

    es.addEventListener('order:created', () => {
      setRefreshTick((t) => t + 1);
      if (rest.soundAlertsEnabled) playKitchenChime();
      pushToast('New order received in kitchen queue');
    });
    es.addEventListener('order:updated', () => setRefreshTick((t) => t + 1));
    es.addEventListener('table:updated', () => setRefreshTick((t) => t + 1));
    es.addEventListener('dining_session:updated', () => setRefreshTick((t) => t + 1));
    es.addEventListener('service:requested', () => {
      setRefreshTick((t) => t + 1);
      if (rest.soundAlertsEnabled) playKitchenChime();
      pushToast('Guest requested waiter/bill assistance');
    });
    es.addEventListener('inventory:alert', () => {
      setRefreshTick((t) => t + 1);
      pushToast('Low-stock alert triggered by order deduction');
    });
    es.addEventListener('payment:updated', (evt) => {
      setRefreshTick((t) => t + 1);
      try {
        const parsed = JSON.parse((evt as MessageEvent).data);
        if (parsed?.payment?.status === 'processing') {
          if (rest.soundAlertsEnabled) playKitchenChime();
          pushToast(`UPI UTR submitted for Table ${parsed.tableNumber || ''} — verify in Billing History`);
        } else if (parsed?.payment?.status === 'pending') {
          if (rest.soundAlertsEnabled) playKitchenChime();
          pushToast(`Customer requested ${parsed.payment.paymentMethodLabel || parsed.payment.method} payment`);
        }
      } catch {
        // ignore parse failure
      }
    });
    es.addEventListener('receipt:created', () => setRefreshTick((t) => t + 1));

    return () => {
      es.close();
    };
  }, [session?.activeRestaurant?.id]);

  // Determine default landing tab based on authenticated role
  const handleAuthenticated = (payload: {
    auth: AuthContextData;
    restaurants: Restaurant[];
    activeRestaurant: Restaurant | null;
  }) => {
    setSession(payload);
    if (!payload.activeRestaurant && payload.auth.isSuperAdmin) {
      setActiveTab('super-admin');
    } else if (payload.auth.role === 'kitchen') {
      setActiveTab('kds');
    } else if (payload.auth.role === 'waiter') {
      setActiveTab('tables');
    } else {
      setActiveTab('dashboard');
    }
  };

  const handleLogout = async () => {
    try {
      if (getAuthToken()) {
        await apiFetch('/auth/logout', { method: 'POST' });
      }
    } catch {
      // ignore if token already expired
    }
    try {
      await signOut(auth);
    } catch {
      // ignore if staff session
    }
    setAuthToken(null);
    setActiveRestaurantId(null);
    setSession(null);
  };

  const navItems = useMemo(() => {
    if (!session) return [];
    const role = session.auth.role;
    const perms = session.auth.permissions;
    const isOwnerOrAdmin = role === 'owner' || session.auth.isSuperAdmin;

    const items: Array<{ id: string; label: string; icon: React.ReactNode }> = [];

    if (session.activeRestaurant) {
      if (isOwnerOrAdmin || role === 'manager') {
        items.push({ id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" /> });
      }
      if (isOwnerOrAdmin || perms.manage_orders) {
        items.push({ id: 'orders', label: 'Orders & POS', icon: <ClipboardList className="w-4 h-4" /> });
      }
      if (isOwnerOrAdmin || perms.manage_tables) {
        items.push({ id: 'tables', label: 'Tables & QR', icon: <Table2 className="w-4 h-4" /> });
      }
      if (isOwnerOrAdmin || perms.kitchen_display) {
        items.push({ id: 'kds', label: 'Kitchen KDS', icon: <ChefHat className="w-4 h-4" /> });
      }
      if (isOwnerOrAdmin || perms.manage_menu) {
        items.push({ id: 'menu', label: 'Menu & Offers', icon: <UtensilsCrossed className="w-4 h-4" /> });
      }
      if (isOwnerOrAdmin || perms.manage_inventory) {
        items.push({ id: 'inventory', label: 'Inventory', icon: <Package className="w-4 h-4" /> });
      }
      if (isOwnerOrAdmin || perms.manage_expenses) {
        items.push({ id: 'expenses', label: 'Expenses', icon: <Receipt className="w-4 h-4" /> });
      }
      if (isOwnerOrAdmin || role === 'manager') {
        items.push({ id: 'customers', label: 'Customers', icon: <Users className="w-4 h-4" /> });
      }
      if (isOwnerOrAdmin || role === 'manager' || perms.view_table_pins) {
        items.push({
          id: 'customer-security',
          label: 'Customer Order Security',
          icon: <KeyRound className="w-4 h-4" />,
        });
      }
      if (isOwnerOrAdmin || perms.manage_staff) {
        items.push({ id: 'staff', label: 'Staff & Audit', icon: <UserCheck className="w-4 h-4" /> });
        items.push({ id: 'security', label: 'Security Activity', icon: <ShieldAlert className="w-4 h-4" /> });
      }
      if (isOwnerOrAdmin || perms.manage_billing || perms.view_reports) {
        items.push({ id: 'billing-history', label: 'Billing History', icon: <FileText className="w-4 h-4" /> });
      }
      if (isOwnerOrAdmin || role === 'manager' || perms.manage_settings) {
        items.push({
          id: 'billing-settings',
          label: 'Billing & Templates',
          icon: <SlidersHorizontal className="w-4 h-4" />,
        });
      }
      if (isOwnerOrAdmin || perms.view_reports) {
        items.push({ id: 'analytics', label: 'Reports & CSV', icon: <BarChart3 className="w-4 h-4" /> });
      }
      if (isOwnerOrAdmin || perms.manage_settings) {
        items.push({ id: 'settings', label: 'Settings', icon: <Settings className="w-4 h-4" /> });
      }
    }

    if (session.auth.isSuperAdmin) {
      items.push({ id: 'super-admin', label: 'Super Admin', icon: <ShieldCheck className="w-4 h-4" /> });
    }

    return items;
  }, [session]);

  // 1. Customer QR Mode (No account needed)
  if (qrToken) {
    return (
      <CustomerQrPortal
        qrToken={qrToken}
        onExit={() => {
          setQrToken(null);
          const url = new URL(window.location.href);
          url.searchParams.delete('qr');
          window.history.replaceState({}, '', url.toString());
        }}
      />
    );
  }

  // 2. Unauthenticated Entry Hub
  if (!session) {
    return (
      <AuthHub
        onAuthenticated={handleAuthenticated}
        onOpenQr={(token) => setQrToken(token)}
      />
    );
  }

  const activeRest = session.activeRestaurant;
  const isOwnerOrAdmin = session.auth.role === 'owner' || session.auth.isSuperAdmin;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col lg:flex-row">
      {/* Desktop Left Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col bg-white border-r border-slate-200 shrink-0 no-print">
        <div className="h-16 px-5 border-b border-slate-200 flex items-center justify-between">
          <span className="text-lg font-bold tracking-tight text-slate-900">DineFlow</span>
          <span className="text-[11px] font-semibold uppercase text-orange-600">
            {session.auth.role.replace('_', ' ')}
          </span>
        </div>

        {/* Outlet Switcher for Owners / Super Admin */}
        {session.restaurants.length > 0 && (
          <div className="p-4 border-b border-slate-100">
            <label className="block text-[11px] font-medium text-slate-500 mb-1">
              Active Restaurant
            </label>
            <select
              value={activeRest?.id || ''}
              disabled={session.restaurants.length <= 1 && !session.auth.isSuperAdmin}
              onChange={(e) => {
                const id = Number(e.target.value);
                const found = session.restaurants.find((r) => r.id === id) || null;
                setActiveRestaurantId(found ? found.id : null);
                setSession({
                  ...session,
                  activeRestaurant: found,
                  auth: { ...session.auth, restaurantId: found ? found.id : null },
                });
                if (found && activeTab === 'super-admin') setActiveTab('dashboard');
              }}
              className="w-full px-2.5 py-2 text-xs font-semibold bg-slate-50 border border-slate-200 rounded-lg"
            >
              {session.restaurants.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`w-full px-3 py-2.5 text-sm font-medium rounded-lg flex items-center gap-2.5 transition-colors cursor-pointer ${
                activeTab === item.id
                  ? 'bg-orange-50 text-orange-700'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              {item.icon}
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-2">
          <div className="text-xs">
            <div className="font-semibold text-slate-900 truncate">{session.auth.displayName}</div>
            <div className="text-slate-500 truncate">{session.auth.email || 'PIN Session'}</div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full py-2 px-3 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" /> Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <header className="h-16 bg-white border-b border-slate-200 px-4 lg:px-8 flex items-center justify-between gap-4 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileMenuOpen((v) => !v)}
              className="lg:hidden p-2 -ml-2 text-slate-700 cursor-pointer"
              aria-label="Toggle Menu"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
            <div className="text-sm text-slate-500 truncate">
              <span className="font-semibold text-slate-900">
                {activeRest ? activeRest.name : 'Platform Administration'}
              </span>
              {activeRest && (
                <>
                  {' · '}
                  <span>{activeRest.city}</span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {activeRest && (isOwnerOrAdmin || session.auth.permissions.manage_orders) && (
              <button
                onClick={() => setActiveTab('orders')}
                className="px-3.5 py-2 text-xs font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-lg cursor-pointer whitespace-nowrap"
              >
                Open POS
              </button>
            )}
            <button
              onClick={handleLogout}
              className="lg:hidden px-3 py-2 text-xs font-medium border border-slate-200 rounded-lg cursor-pointer"
            >
              Exit
            </button>
          </div>
        </header>

        {/* Mobile Drawer Navigation */}
        {mobileMenuOpen && (
          <div className="lg:hidden bg-white border-b border-slate-200 p-3 grid grid-cols-2 gap-1.5 no-print">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  setActiveTab(item.id);
                  setMobileMenuOpen(false);
                }}
                className={`px-3 py-2.5 text-xs font-medium rounded-lg flex items-center gap-2 cursor-pointer ${
                  activeTab === item.id
                    ? 'bg-orange-50 text-orange-700'
                    : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                {item.icon}
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </div>
        )}

        {toast && (
          <div className="fixed bottom-5 right-5 z-50 bg-slate-900 text-white text-xs font-medium px-4 py-3 rounded-xl shadow-lg no-print">
            {toast}
          </div>
        )}

        {/* Active View Viewport */}
        <main className="flex-1 p-4 lg:p-8 max-w-7xl w-full mx-auto">
          {activeTab === 'dashboard' && activeRest && (
            <OwnerDashboardView
              refreshTick={refreshTick}
              onNavigate={(tab) => setActiveTab(tab)}
            />
          )}

          {activeTab === 'orders' && activeRest && (
            <OrdersAndPosView
              restaurant={activeRest}
              refreshTick={refreshTick}
              initialPosTableId={posTableId}
              onClearInitialTable={() => setPosTableId(null)}
              canCancelOrders={isOwnerOrAdmin || Boolean(session.auth.permissions.cancel_orders)}
              canManageBilling={isOwnerOrAdmin || Boolean(session.auth.permissions.manage_billing)}
            />
          )}

          {activeTab === 'tables' && activeRest && (
            <TablesAndQrView
              restaurant={activeRest}
              refreshTick={refreshTick}
              canManageTables={isOwnerOrAdmin || Boolean(session.auth.permissions.manage_tables)}
              onOpenQr={(token) => setQrToken(token)}
              onOpenPosForTable={(tableId) => {
                setPosTableId(tableId);
                setActiveTab('orders');
              }}
            />
          )}

          {activeTab === 'kds' && activeRest && (
            <KitchenDisplay
              refreshTick={refreshTick}
              soundEnabled={activeRest.soundAlertsEnabled}
            />
          )}

          {activeTab === 'menu' && activeRest && (
            <MenuManagementView
              canManageMenu={isOwnerOrAdmin || Boolean(session.auth.permissions.manage_menu)}
            />
          )}

          {activeTab === 'inventory' && activeRest && (
            <InventoryView
              canManageInventory={isOwnerOrAdmin || Boolean(session.auth.permissions.manage_inventory)}
            />
          )}

          {activeTab === 'expenses' && activeRest && (
            <ExpensesView
              canManageExpenses={isOwnerOrAdmin || Boolean(session.auth.permissions.manage_expenses)}
            />
          )}

          {activeTab === 'customers' && activeRest && (
            <CustomersAndStaffView mode="customers" canManageStaff={false} />
          )}

          {activeTab === 'staff' && activeRest && (
            <CustomersAndStaffView
              mode="staff"
              canManageStaff={isOwnerOrAdmin || Boolean(session.auth.permissions.manage_staff)}
            />
          )}

          {activeTab === 'customer-security' && activeRest && (
            <CustomerOrderSecurityView refreshTick={refreshTick} />
          )}

          {activeTab === 'security' && activeRest && <SecurityView />}

          {activeTab === 'billing-history' && activeRest && (
            <BillingHistoryView
              refreshKey={refreshTick}
              canConfirmPayments={isOwnerOrAdmin || Boolean(session.auth.permissions.manage_billing)}
              canRefund={
                isOwnerOrAdmin ||
                (Boolean(session.auth.permissions.manage_billing) &&
                  (session.auth.role === 'manager' || Boolean(session.auth.permissions.cancel_orders)))
              }
            />
          )}

          {activeTab === 'billing-settings' && activeRest && (
            <BillingSettingsView
              onRestaurantUpdated={(updated) =>
                setSession((prev) =>
                  prev
                    ? {
                        ...prev,
                        activeRestaurant: updated,
                        restaurants: prev.restaurants.map((r) =>
                          r.id === updated.id ? updated : r,
                        ),
                      }
                    : null,
                )
              }
            />
          )}

          {activeTab === 'analytics' && activeRest && <AnalyticsView />}

          {activeTab === 'settings' && activeRest && (
            <SettingsView
              restaurant={activeRest}
              canManageSettings={isOwnerOrAdmin || Boolean(session.auth.permissions.manage_settings)}
              onUpdated={(updated) =>
                setSession((prev) =>
                  prev
                    ? {
                        ...prev,
                        activeRestaurant: updated,
                        restaurants: prev.restaurants.map((r) =>
                          r.id === updated.id ? updated : r,
                        ),
                      }
                    : null,
                )
              }
            />
          )}

          {activeTab === 'super-admin' && session.auth.isSuperAdmin && (
            <SuperAdminView
              onSwitchToRestaurant={(rest) => {
                setActiveRestaurantId(rest.id);
                setSession((prev) =>
                  prev
                    ? {
                        ...prev,
                        activeRestaurant: rest,
                        auth: { ...prev.auth, restaurantId: rest.id },
                      }
                    : null,
                );
                setActiveTab('dashboard');
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}
