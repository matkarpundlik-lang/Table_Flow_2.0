import React, { useEffect, useState } from 'react';
import { AlertTriangle, Plus, X } from 'lucide-react';
import { apiFetch, formatInr } from '../lib/api';
import {
  InventoryItem,
  MenuItem,
  RecipeMapping,
  StockMovement,
  Supplier,
} from '../types/dineflow';

export const InventoryView: React.FC<{
  canManageInventory: boolean;
}> = ({ canManageInventory }) => {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [recipes, setRecipes] = useState<RecipeMapping[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [tab, setTab] = useState<'stock' | 'recipes' | 'suppliers' | 'ledger'>('stock');

  const [adjustItem, setAdjustItem] = useState<InventoryItem | null>(null);
  const [adjustForm, setAdjustForm] = useState({
    movementType: 'purchase' as 'purchase' | 'wastage' | 'adjustment',
    quantity: '',
    notes: '',
  });

  const [showAddItem, setShowAddItem] = useState(false);
  const [newItem, setNewItem] = useState({
    name: '',
    category: 'Ingredients',
    unit: 'kg',
    currentStock: '10',
    reorderLevel: '5',
    costPerUnit: '150',
    supplierId: '',
  });

  const [newSupplier, setNewSupplier] = useState({
    name: '',
    contactPerson: '',
    phone: '',
    category: 'Groceries & Produce',
  });

  const [selectedMenuId, setSelectedMenuId] = useState<number | ''>('');
  const [recipeDraft, setRecipeDraft] = useState<Array<{ inventoryItemId: number; quantityRequired: number }>>([]);
  const [recipeSavedMsg, setRecipeSavedMsg] = useState('');

  const loadAll = async () => {
    try {
      const [invRes, menuRes] = await Promise.all([
        apiFetch<{
          items: InventoryItem[];
          suppliers: Supplier[];
          recipes: RecipeMapping[];
          movements: StockMovement[];
        }>('/inventory'),
        apiFetch<{ items: MenuItem[] }>('/menu'),
      ]);
      setItems(invRes.items);
      setSuppliers(invRes.suppliers);
      setRecipes(invRes.recipes);
      setMovements(invRes.movements);
      setMenuItems(menuRes.items);
      if (menuRes.items.length > 0 && !selectedMenuId) {
        const firstId = menuRes.items[0].id;
        setSelectedMenuId(firstId);
        setRecipeDraft(
          invRes.recipes
            .filter((r) => r.menuItemId === firstId)
            .map((r) => ({ inventoryItemId: r.inventoryItemId, quantityRequired: r.quantityRequired })),
        );
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleSelectMenuForRecipe = (id: number) => {
    setSelectedMenuId(id);
    setRecipeDraft(
      recipes
        .filter((r) => r.menuItemId === id)
        .map((r) => ({ inventoryItemId: r.inventoryItemId, quantityRequired: r.quantityRequired })),
    );
    setRecipeSavedMsg('');
  };

  const handleSaveRecipe = async () => {
    if (!selectedMenuId) return;
    await apiFetch(`/inventory/recipes/${selectedMenuId}`, {
      method: 'PUT',
      body: JSON.stringify({ ingredients: recipeDraft }),
    });
    setRecipeSavedMsg('Recipe saved. Future orders will auto-deduct these ingredients once.');
    await loadAll();
  };

  const handleAdjustStock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustItem) return;
    await apiFetch('/inventory/adjust', {
      method: 'POST',
      body: JSON.stringify({
        inventoryItemId: adjustItem.id,
        movementType: adjustForm.movementType,
        quantity: Number(adjustForm.quantity),
        notes: adjustForm.notes,
      }),
    });
    setAdjustItem(null);
    setAdjustForm({ movementType: 'purchase', quantity: '', notes: '' });
    await loadAll();
  };

  const handleCreateItem = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/inventory/items', {
      method: 'POST',
      body: JSON.stringify({
        ...newItem,
        currentStock: Number(newItem.currentStock),
        reorderLevel: Number(newItem.reorderLevel),
        costPerUnit: Number(newItem.costPerUnit),
        supplierId: newItem.supplierId ? Number(newItem.supplierId) : null,
      }),
    });
    setShowAddItem(false);
    setNewItem({
      name: '',
      category: 'Ingredients',
      unit: 'kg',
      currentStock: '10',
      reorderLevel: '5',
      costPerUnit: '150',
      supplierId: '',
    });
    await loadAll();
  };

  const handleCreateSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/inventory/suppliers', {
      method: 'POST',
      body: JSON.stringify(newSupplier),
    });
    setNewSupplier({ name: '', contactPerson: '', phone: '', category: 'Groceries & Produce' });
    await loadAll();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Inventory, Suppliers & Recipes</h2>
          <p className="text-sm text-slate-500">
            Track ingredient stock, purchase entries, wastage, and recipe-based auto-deduction on orders.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 border border-slate-200 rounded-lg">
            {[
              { id: 'stock', label: 'Stock Levels' },
              { id: 'recipes', label: 'Dish Recipes' },
              { id: 'suppliers', label: 'Suppliers' },
              { id: 'ledger', label: 'Movements' },
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
          {canManageInventory && tab === 'stock' && (
            <button
              onClick={() => setShowAddItem(true)}
              className="px-4 py-2 text-sm font-semibold bg-orange-600 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" /> Add Ingredient
            </button>
          )}
        </div>
      </div>

      {tab === 'stock' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-3 px-4">Ingredient</th>
                  <th className="py-3 px-4">Category</th>
                  <th className="py-3 px-4 text-right">Current Stock</th>
                  <th className="py-3 px-4 text-right">Reorder Level</th>
                  <th className="py-3 px-4 text-right">Cost / Unit</th>
                  <th className="py-3 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {items.map((item) => {
                  const isLow = item.currentStock <= item.reorderLevel;
                  return (
                    <tr key={item.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                          {isLow && <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />}
                          {item.name}
                        </div>
                        <div className="text-xs text-slate-500 font-mono-num">{item.sku}</div>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600">{item.category}</td>
                      <td className="py-3 px-4 text-right font-mono-num font-bold">
                        <span className={isLow ? 'text-red-700' : 'text-slate-900'}>
                          {item.currentStock.toFixed(2)} {item.unit}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono-num text-xs text-slate-500">
                        {item.reorderLevel} {item.unit}
                      </td>
                      <td className="py-3 px-4 text-right font-mono-num text-slate-700">
                        {formatInr(item.costPerUnit)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {canManageInventory && (
                          <button
                            onClick={() => setAdjustItem(item)}
                            className="px-3 py-1.5 text-xs font-medium border border-slate-200 hover:bg-slate-100 rounded-lg cursor-pointer"
                          >
                            Purchase / Adjust
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'recipes' && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5 max-w-3xl">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Select Menu Dish to Configure Ingredient Deduction
            </label>
            <select
              value={selectedMenuId}
              onChange={(e) => handleSelectMenuForRecipe(Number(e.target.value))}
              className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg bg-white"
            >
              {menuItems.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({formatInr(m.price)})
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-3">
            {recipeDraft.map((row, idx) => (
              <div key={idx} className="flex items-center gap-3">
                <select
                  value={row.inventoryItemId}
                  onChange={(e) => {
                    const next = [...recipeDraft];
                    next[idx].inventoryItemId = Number(e.target.value);
                    setRecipeDraft(next);
                  }}
                  className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  {items.map((ing) => (
                    <option key={ing.id} value={ing.id}>
                      {ing.name} ({ing.unit})
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={row.quantityRequired}
                  onChange={(e) => {
                    const next = [...recipeDraft];
                    next[idx].quantityRequired = Number(e.target.value);
                    setRecipeDraft(next);
                  }}
                  className="w-32 px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
                />
                <button
                  type="button"
                  onClick={() => setRecipeDraft((r) => r.filter((_, i) => i !== idx))}
                  className="text-xs text-red-600 cursor-pointer"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 pt-2">
            {items.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  setRecipeDraft((r) => [...r, { inventoryItemId: items[0].id, quantityRequired: 0.1 }])
                }
                className="px-3.5 py-2 text-xs font-medium border border-slate-300 rounded-lg cursor-pointer"
              >
                + Add Ingredient
              </button>
            )}
            {canManageInventory && (
              <button
                type="button"
                onClick={handleSaveRecipe}
                className="px-4 py-2 text-xs font-semibold bg-orange-600 text-white rounded-lg cursor-pointer"
              >
                Save Recipe Mapping
              </button>
            )}
          </div>
          {recipeSavedMsg && <p className="text-xs text-emerald-700 font-medium">{recipeSavedMsg}</p>}
        </div>
      )}

      {tab === 'suppliers' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {canManageInventory && (
            <form
              onSubmit={handleCreateSupplier}
              className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
            >
              <h3 className="text-sm font-bold text-slate-900">Add Supplier</h3>
              <input
                required
                value={newSupplier.name}
                onChange={(e) => setNewSupplier({ ...newSupplier, name: e.target.value })}
                placeholder="Supplier Name"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              <input
                value={newSupplier.contactPerson}
                onChange={(e) => setNewSupplier({ ...newSupplier, contactPerson: e.target.value })}
                placeholder="Contact Person"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              <input
                value={newSupplier.phone}
                onChange={(e) => setNewSupplier({ ...newSupplier, phone: e.target.value })}
                placeholder="Phone"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              <input
                value={newSupplier.category}
                onChange={(e) => setNewSupplier({ ...newSupplier, category: e.target.value })}
                placeholder="Supply Category"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              <button
                type="submit"
                className="w-full py-2 text-sm font-semibold bg-orange-600 text-white rounded-lg cursor-pointer"
              >
                Save Supplier
              </button>
            </form>
          )}
          <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
            {suppliers.map((s) => (
              <div key={s.id} className="p-4 flex items-center justify-between">
                <div>
                  <div className="font-semibold text-slate-900">{s.name}</div>
                  <div className="text-xs text-slate-500">
                    {s.contactPerson} · {s.phone} · {s.category}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'ledger' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-3 px-4">Time</th>
                  <th className="py-3 px-4">Ingredient</th>
                  <th className="py-3 px-4">Type</th>
                  <th className="py-3 px-4 text-right">Delta</th>
                  <th className="py-3 px-4">Notes</th>
                  <th className="py-3 px-4">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {movements.map((m) => {
                  const item = items.find((i) => i.id === m.inventoryItemId);
                  return (
                    <tr key={m.id}>
                      <td className="py-2.5 px-4 text-slate-500 font-mono-num">
                        {new Date(m.createdAt).toLocaleString('en-IN', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="py-2.5 px-4 font-medium text-slate-900">{item?.name || `#${m.inventoryItemId}`}</td>
                      <td className="py-2.5 px-4 uppercase font-semibold text-slate-600">{m.movementType}</td>
                      <td
                        className={`py-2.5 px-4 text-right font-mono-num font-bold ${
                          m.quantityDelta >= 0 ? 'text-emerald-700' : 'text-red-600'
                        }`}
                      >
                        {m.quantityDelta >= 0 ? '+' : ''}
                        {m.quantityDelta.toFixed(2)} {item?.unit}
                      </td>
                      <td className="py-2.5 px-4 text-slate-600">{m.notes}</td>
                      <td className="py-2.5 px-4 text-slate-500">{m.createdBy}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Adjust Stock Modal */}
      {adjustItem && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form onSubmit={handleAdjustStock} className="bg-white w-full max-w-md rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">Update Stock · {adjustItem.name}</h3>
              <button type="button" onClick={() => setAdjustItem(null)} className="cursor-pointer">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            <select
              value={adjustForm.movementType}
              onChange={(e) =>
                setAdjustForm({ ...adjustForm, movementType: e.target.value as 'purchase' | 'wastage' | 'adjustment' })
              }
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="purchase">Purchase Restock (+)</option>
              <option value="wastage">Log Wastage / Spoilage (-)</option>
              <option value="adjustment">Manual Audit Adjustment (+/-)</option>
            </select>
            <input
              required
              type="number"
              step="0.01"
              value={adjustForm.quantity}
              onChange={(e) => setAdjustForm({ ...adjustForm, quantity: e.target.value })}
              placeholder={`Quantity in ${adjustItem.unit}`}
              className="w-full px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
            />
            <input
              value={adjustForm.notes}
              onChange={(e) => setAdjustForm({ ...adjustForm, notes: e.target.value })}
              placeholder="Invoice # or wastage reason..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
            <button
              type="submit"
              className="w-full py-2.5 text-sm font-semibold bg-orange-600 text-white rounded-xl cursor-pointer"
            >
              Commit Stock Movement
            </button>
          </form>
        </div>
      )}

      {/* Add Inventory Item Modal */}
      {showAddItem && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form onSubmit={handleCreateItem} className="bg-white w-full max-w-md rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">New Inventory Ingredient</h3>
              <button type="button" onClick={() => setShowAddItem(false)} className="cursor-pointer">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            <input
              required
              value={newItem.name}
              onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
              placeholder="Ingredient Name"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
            <div className="grid grid-cols-2 gap-3">
              <input
                value={newItem.category}
                onChange={(e) => setNewItem({ ...newItem, category: e.target.value })}
                placeholder="Category"
                className="px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              <input
                value={newItem.unit}
                onChange={(e) => setNewItem({ ...newItem, unit: e.target.value })}
                placeholder="Unit (kg, ltr, pcs)"
                className="px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <input
                type="number"
                step="0.1"
                value={newItem.currentStock}
                onChange={(e) => setNewItem({ ...newItem, currentStock: e.target.value })}
                placeholder="Opening Qty"
                className="px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
              />
              <input
                type="number"
                step="0.1"
                value={newItem.reorderLevel}
                onChange={(e) => setNewItem({ ...newItem, reorderLevel: e.target.value })}
                placeholder="Reorder Min"
                className="px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
              />
              <input
                type="number"
                value={newItem.costPerUnit}
                onChange={(e) => setNewItem({ ...newItem, costPerUnit: e.target.value })}
                placeholder="Cost ₹"
                className="px-3 py-2 text-sm font-mono-num border border-slate-300 rounded-lg"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 text-sm font-semibold bg-orange-600 text-white rounded-xl cursor-pointer"
            >
              Add Ingredient
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
