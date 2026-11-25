import React, { useEffect, useState } from 'react';
import { Plus, Tag, Trash2, Utensils, X } from 'lucide-react';
import { apiFetch, formatInr } from '../lib/api';
import { MenuCategory, MenuItem, PromotionalOffer } from '../types/dineflow';

const PRESET_DISH_IMAGES = [
  { label: 'No Photo', url: '' },
  { label: 'Butter Chicken', url: '/src/assets/images/dish_butter_chicken_1795292950397.jpg' },
  { label: 'Paneer Tikka', url: '/src/assets/images/dish_paneer_tikka_1795292950363.jpg' },
  { label: 'Masala Dosa', url: '/src/assets/images/dish_masala_dosa_1795292950456.jpg' },
  { label: 'Filter Coffee', url: '/src/assets/images/dish_filter_coffee_1795292950410.jpg' },
  { label: 'Avocado Toast', url: '/src/assets/images/dish_avocado_toast_1795292950417.jpg' },
];

export const MenuManagementView: React.FC<{
  canManageMenu: boolean;
}> = ({ canManageMenu }) => {
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [offers, setOffers] = useState<PromotionalOffer[]>([]);
  const [tab, setTab] = useState<'items' | 'categories' | 'offers'>('items');
  const [loading, setLoading] = useState(true);

  const [newCatName, setNewCatName] = useState('');
  const [showItemModal, setShowItemModal] = useState(false);
  const [itemForm, setItemForm] = useState({
    categoryId: '',
    name: '',
    description: '',
    price: '',
    isVeg: true,
    prepTimeMins: '15',
    imageUrl: '',
    isCombo: false,
    comboDetails: '',
    variantText: '',
    addonText: '',
  });

  const [offerForm, setOfferForm] = useState({
    title: '',
    code: '',
    discountType: 'percent' as 'percent' | 'flat',
    discountValue: '',
    minOrderAmount: '300',
    maxDiscount: '200',
  });

  const loadMenu = async () => {
    try {
      const res = await apiFetch<{
        categories: MenuCategory[];
        items: MenuItem[];
        offers: PromotionalOffer[];
      }>('/menu');
      setCategories(res.categories);
      setItems(res.items);
      setOffers(res.offers);
      if (res.categories.length > 0 && !itemForm.categoryId) {
        setItemForm((f) => ({ ...f, categoryId: String(res.categories[0].id) }));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMenu();
  }, []);

  const handleToggleAvailability = async (item: MenuItem) => {
    if (!canManageMenu) return;
    await apiFetch(`/menu/items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isAvailable: !item.isAvailable }),
    });
    await loadMenu();
  };

  const handleCreateItem = async (e: React.FormEvent) => {
    e.preventDefault();
    const variants = itemForm.variantText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair, idx) => {
        const [name, delta] = pair.split(':');
        return { id: `v_${idx}`, name: name.trim(), priceDelta: Number(delta || 0) };
      });
    const addons = itemForm.addonText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair, idx) => {
        const [name, price] = pair.split(':');
        return { id: `a_${idx}`, name: name.trim(), price: Number(price || 0) };
      });

    await apiFetch('/menu/items', {
      method: 'POST',
      body: JSON.stringify({
        categoryId: Number(itemForm.categoryId),
        name: itemForm.name,
        description: itemForm.description,
        price: Number(itemForm.price),
        isVeg: itemForm.isVeg,
        prepTimeMins: Number(itemForm.prepTimeMins) || 15,
        imageUrl: itemForm.imageUrl,
        isCombo: itemForm.isCombo,
        comboDetails: itemForm.comboDetails,
        variants,
        addons,
      }),
    });
    setShowItemModal(false);
    setItemForm({
      categoryId: categories[0] ? String(categories[0].id) : '',
      name: '',
      description: '',
      price: '',
      isVeg: true,
      prepTimeMins: '15',
      imageUrl: '',
      isCombo: false,
      comboDetails: '',
      variantText: '',
      addonText: '',
    });
    await loadMenu();
  };

  const handleDeleteItem = async (id: number) => {
    await apiFetch(`/menu/items/${id}`, { method: 'DELETE' });
    await loadMenu();
  };

  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatName.trim()) return;
    await apiFetch('/menu/categories', {
      method: 'POST',
      body: JSON.stringify({ name: newCatName }),
    });
    setNewCatName('');
    await loadMenu();
  };

  const handleCreateOffer = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/menu/offers', {
      method: 'POST',
      body: JSON.stringify({
        ...offerForm,
        discountValue: Number(offerForm.discountValue),
        minOrderAmount: Number(offerForm.minOrderAmount),
        maxDiscount: Number(offerForm.maxDiscount),
      }),
    });
    setOfferForm({
      title: '',
      code: '',
      discountType: 'percent',
      discountValue: '',
      minOrderAmount: '300',
      maxDiscount: '200',
    });
    await loadMenu();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Menu, Combos & Offers</h2>
          <p className="text-sm text-slate-500">
            Changes sync immediately to live Customer QR menus and POS terminals.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 border border-slate-200 rounded-lg">
            {[
              { id: 'items', label: `Dishes (${items.length})` },
              { id: 'categories', label: `Categories (${categories.length})` },
              { id: 'offers', label: `Offers (${offers.length})` },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id as typeof tab)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                  tab === t.id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {canManageMenu && tab === 'items' && (
            <button
              onClick={() => setShowItemModal(true)}
              className="px-4 py-2 text-sm font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" /> Add Dish
            </button>
          )}
        </div>
      </div>

      {tab === 'items' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {loading ? (
            <div className="col-span-full py-10 text-center text-sm text-slate-400">Loading menu...</div>
          ) : (
            items.map((item) => {
              const cat = categories.find((c) => c.id === item.categoryId);
              return (
                <div
                  key={item.id}
                  className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col justify-between"
                >
                  <div className="p-4 flex gap-3.5">
                    <div className="w-20 h-20 rounded-lg bg-slate-100 overflow-hidden shrink-0 flex items-center justify-center">
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt={item.name}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <Utensils className="w-6 h-6 text-slate-400" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="text-xs text-slate-500">
                        <span className={item.isVeg ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold'}>
                          {item.isVeg ? 'Veg' : 'Non-Veg'}
                        </span>
                        {' · '}
                        <span>{cat?.name || 'Uncategorized'}</span>
                      </div>
                      <h3 className="text-sm font-bold text-slate-900 truncate">{item.name}</h3>
                      <p className="text-xs text-slate-500 line-clamp-2">{item.description}</p>
                    </div>
                  </div>

                  <div className="px-4 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                    <span className="font-mono-num font-bold text-slate-900">
                      {formatInr(item.price)}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        disabled={!canManageMenu}
                        onClick={() => handleToggleAvailability(item)}
                        className={`px-2.5 py-1 text-xs font-semibold rounded border cursor-pointer ${
                          item.isAvailable
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : 'bg-red-50 text-red-700 border-red-200'
                        }`}
                      >
                        {item.isAvailable ? 'Available' : 'Sold Out'}
                      </button>
                      {canManageMenu && (
                        <button
                          onClick={() => handleDeleteItem(item.id)}
                          className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {tab === 'categories' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 max-w-2xl">
          {canManageMenu && (
            <form onSubmit={handleCreateCategory} className="flex gap-2">
              <input
                required
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                placeholder="New category name (e.g. Biryanis & Pulao)"
                className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              <button
                type="submit"
                className="px-4 py-2 text-sm font-semibold bg-orange-600 text-white rounded-lg cursor-pointer"
              >
                Add Category
              </button>
            </form>
          )}

          <div className="divide-y divide-slate-100">
            {categories.map((cat) => (
              <div key={cat.id} className="py-3 flex items-center justify-between text-sm">
                <span className="font-semibold text-slate-900">{cat.name}</span>
                {canManageMenu && (
                  <button
                    onClick={async () => {
                      await apiFetch(`/menu/categories/${cat.id}`, { method: 'DELETE' });
                      await loadMenu();
                    }}
                    className="text-xs text-red-600 hover:underline cursor-pointer"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'offers' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {canManageMenu && (
            <form
              onSubmit={handleCreateOffer}
              className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
            >
              <h3 className="text-sm font-bold text-slate-900">Create Promo Offer</h3>
              <input
                required
                value={offerForm.title}
                onChange={(e) => setOfferForm({ ...offerForm, title: e.target.value })}
                placeholder="Offer title (e.g. Weekend Feast 15%)"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              <input
                required
                value={offerForm.code}
                onChange={(e) => setOfferForm({ ...offerForm, code: e.target.value.toUpperCase() })}
                placeholder="Code (e.g. WEEKEND15)"
                className="w-full px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
              />
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={offerForm.discountType}
                  onChange={(e) =>
                    setOfferForm({ ...offerForm, discountType: e.target.value as 'percent' | 'flat' })
                  }
                  className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="percent">Percentage (%)</option>
                  <option value="flat">Flat (₹)</option>
                </select>
                <input
                  required
                  type="number"
                  value={offerForm.discountValue}
                  onChange={(e) => setOfferForm({ ...offerForm, discountValue: e.target.value })}
                  placeholder="Value"
                  className="px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  value={offerForm.minOrderAmount}
                  onChange={(e) => setOfferForm({ ...offerForm, minOrderAmount: e.target.value })}
                  placeholder="Min Order ₹"
                  className="px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
                />
                <input
                  type="number"
                  value={offerForm.maxDiscount}
                  onChange={(e) => setOfferForm({ ...offerForm, maxDiscount: e.target.value })}
                  placeholder="Max Cap ₹"
                  className="px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
                />
              </div>
              <button
                type="submit"
                className="w-full py-2.5 text-sm font-semibold bg-orange-600 text-white rounded-lg cursor-pointer"
              >
                Publish Offer
              </button>
            </form>
          )}

          <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
            {offers.map((off) => (
              <div key={off.id} className="p-4 flex items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <Tag className="w-4 h-4 text-orange-600" />
                    <span className="font-mono-num font-bold text-slate-900">{off.code}</span>
                    <span className="text-sm font-medium text-slate-700">{off.title}</span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    {off.discountType === 'percent' ? `${off.discountValue}% off` : `${formatInr(off.discountValue)} flat off`}
                    {' · '}Min order {formatInr(off.minOrderAmount)}
                  </div>
                </div>
                {canManageMenu && (
                  <button
                    onClick={async () => {
                      await apiFetch(`/menu/offers/${off.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ isActive: !off.isActive }),
                      });
                      await loadMenu();
                    }}
                    className={`px-3 py-1 text-xs font-semibold rounded border cursor-pointer ${
                      off.isActive
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-slate-100 text-slate-600 border-slate-200'
                    }`}
                  >
                    {off.isActive ? 'Active' : 'Paused'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Menu Item Modal */}
      {showItemModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateItem}
            className="bg-white w-full max-w-lg rounded-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">Add New Menu Item</h3>
              <button type="button" onClick={() => setShowItemModal(false)} className="cursor-pointer">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Category</label>
                <select
                  required
                  value={itemForm.categoryId}
                  onChange={(e) => setItemForm({ ...itemForm, categoryId: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Price (₹)</label>
                <input
                  required
                  type="number"
                  step="0.01"
                  value={itemForm.price}
                  onChange={(e) => setItemForm({ ...itemForm, price: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Dish Name</label>
              <input
                required
                value={itemForm.name}
                onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Description</label>
              <textarea
                rows={2}
                value={itemForm.description}
                onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Dish Photo Preset</label>
                <select
                  value={itemForm.imageUrl}
                  onChange={(e) => setItemForm({ ...itemForm, imageUrl: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  {PRESET_DISH_IMAGES.map((p) => (
                    <option key={p.label} value={p.url}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Prep Time (mins)</label>
                <input
                  type="number"
                  value={itemForm.prepTimeMins}
                  onChange={(e) => setItemForm({ ...itemForm, prepTimeMins: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={itemForm.isVeg}
                  onChange={(e) => setItemForm({ ...itemForm, isVeg: e.target.checked })}
                />
                Vegetarian Dish
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={itemForm.isCombo}
                  onChange={(e) => setItemForm({ ...itemForm, isCombo: e.target.checked })}
                />
                Combo Meal
              </label>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Variants (Optional: e.g. Half:0, Full:180)
              </label>
              <input
                value={itemForm.variantText}
                onChange={(e) => setItemForm({ ...itemForm, variantText: e.target.value })}
                placeholder="Regular:0, Large:120"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Add-ons (Optional: e.g. Extra Cheese:50, Butter:35)
              </label>
              <input
                value={itemForm.addonText}
                onChange={(e) => setItemForm({ ...itemForm, addonText: e.target.value })}
                placeholder="Extra Chutney:30, Garlic Naan:85"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>

            <button
              type="submit"
              className="w-full py-2.5 text-sm font-semibold bg-orange-600 text-white rounded-xl cursor-pointer"
            >
              Publish Dish to Menu
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
