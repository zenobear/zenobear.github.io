/* ==========================================================================
   Zeno Bear Business Management System
   Data layer: Supabase (PostgreSQL)
   ========================================================================== */

// ========== SUPABASE CONFIG ==========
// Replace these with your Project URL and Publishable (or anon) key
// from Supabase Dashboard → Project Settings → API
const SUPABASE_URL = 'https://tksdtlbcyfdjgepocmli.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_di4exRpweo2ctbGHSjFBpw_dOLJ_l_c';

// Support both UMD global shapes: window.supabase.createClient or window.supabase.supabase
function createSupabaseClient() {
    const lib = window.supabase;
    if (!lib) {
        console.error('Supabase library not loaded. Check the CDN script in index.html.');
        return null;
    }
    const createClient = lib.createClient || (lib.supabase && lib.supabase.createClient);
    if (!createClient) {
        console.error('createClient not found on Supabase library.', lib);
        return null;
    }
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

const supabaseClient = createSupabaseClient();

function db() {
    if (!supabaseClient) {
        throw new Error('Supabase is not connected. Check internet and the CDN script.');
    }
    return supabaseClient;
}


/* ==========================================================================
   1. PRODUCT BUSINESS LOGIC MODULE
   ========================================================================== */
const ProductLogic = {
    mapRow(p) {
        return {
            id: p.id,
            name: p.name,
            sku: p.sku,
            barcode: p.barcode,
            category: p.category,
            design: p.design,
            size: p.size,
            color: p.color,
            price: Number(p.price),
            cost: Number(p.cost),
            stock: p.stock,
            minStock: p.min_stock,
            status: p.available ? 'Active' : 'Inactive'
        };
    },

    async getAll() {
        const { data, error } = await db()
            .from('products')
            .select('*')
            .order('name');
        if (error) {
            console.error(error);
            showToast('Error loading products: ' + error.message);
            return [];
        }
        return (data || []).map(ProductLogic.mapRow);
    },

    async getById(id) {
        const { data, error } = await db()
            .from('products')
            .select('*')
            .eq('id', id)
            .maybeSingle();
        if (error || !data) return null;
        return ProductLogic.mapRow(data);
    },

    async saveProduct(productData) {
        const row = {
            name: productData.name,
            sku: productData.sku,
            barcode: productData.barcode,
            category: productData.category,
            design: productData.design || null,
            size: productData.size || null,
            color: productData.color || null,
            price: productData.price,
            cost: productData.cost ?? 0,
            stock: productData.stock ?? 0,
            min_stock: productData.minStock ?? 0,
            available: (productData.status ?? 'Active') === 'Active'
        };

        if (productData.id) {
            const { error } = await db()
                .from('products')
                .update(row)
                .eq('id', productData.id);
            if (error) throw error;
        } else {
            const { error } = await db().from('products').insert(row);
            if (error) throw error;
        }
    },

    async addStock(id, qty) {
        const p = await ProductLogic.getById(id);
        if (!p) return;
        const { error } = await db()
            .from('products')
            .update({ stock: p.stock + parseInt(qty, 10) })
            .eq('id', id);
        if (error) throw error;
    },

    async toggleStatus(id) {
        const p = await ProductLogic.getById(id);
        if (!p) return;
        const { error } = await db()
            .from('products')
            .update({ available: p.status !== 'Active' })
            .eq('id', id);
        if (error) throw error;
    },

    async deleteProduct(id) {
        const { error } = await db()
            .from('products')
            .delete()
            .eq('id', id);
        if (error) throw error;
    },

    async deductStockForSale(cart) {
        for (const item of cart) {
            const { error } = await db().rpc('deduct_stock', {
                p_product_id: item.id,
                p_qty: item.qty
            });
            if (error) throw error;
        }
    }
};

/* ==========================================================================
   2. STAFF BUSINESS LOGIC MODULE
   ========================================================================== */
const StaffLogic = {
    mapRow(s) {
        return {
            id: s.id,
            name: s.name,
            active: s.active,
            registeredAt: s.registered_at
        };
    },

    async getAll() {
        const { data, error } = await db()
            .from('staff')
            .select('*')
            .order('name');
        if (error) {
            console.error(error);
            showToast('Error loading staff: ' + error.message);
            return [];
        }
        return (data || []).map(StaffLogic.mapRow);
    },

    async getById(id) {
        const { data, error } = await db()
            .from('staff')
            .select('*')
            .eq('id', id)
            .maybeSingle();
        if (error || !data) return null;
        return StaffLogic.mapRow(data);
    },

    async getActive() {
        const { data, error } = await db()
            .from('staff')
            .select('*')
            .eq('active', true)
            .order('name');
        if (error) {
            console.error(error);
            return [];
        }
        return (data || []).map(StaffLogic.mapRow);
    },

    async add(name) {
        const trimmed = name.trim();
        if (!trimmed) return { ok: false, message: 'Name is required' };
        const { error } = await db()
            .from('staff')
            .insert({ name: trimmed, active: true });
        if (error) {
            if (error.code === '23505') {
                return { ok: false, message: 'A staff member with this name already exists' };
            }
            return { ok: false, message: error.message };
        }
        return { ok: true };
    },

    async toggleActive(id) {
        const s = await StaffLogic.getById(id);
        if (!s) return;
        const { error } = await db()
            .from('staff')
            .update({ active: !s.active })
            .eq('id', id);
        if (error) throw error;
    },

    async remove(id) {
        const { error } = await db().from('staff').delete().eq('id', id);
        if (error) throw error;
    }
};

/* ==========================================================================
   3. SALES BUSINESS LOGIC MODULE
   ========================================================================== */
const SalesLogic = {
    async getAll() {
        const { data, error } = await db()
            .from('sales')
            .select(`
                *,
                sale_items ( product_id, product_name, qty, unit_price, subtotal )
            `)
            .order('sold_at', { ascending: false });
        if (error) {
            console.error(error);
            showToast('Error loading sales: ' + error.message);
            return [];
        }

        return (data || []).map(s => ({
            id: s.txn_number,
            date: new Date(s.sold_at).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric'
            }),
            time: new Date(s.sold_at).toLocaleTimeString('en-US', {
                hour: '2-digit', minute: '2-digit'
            }),
            rawDate: s.sold_at,
            cashier: s.cashier_name,
            items: (s.sale_items || []).map(i => ({
                id: i.product_id,
                name: i.product_name,
                qty: i.qty,
                price: Number(i.unit_price),
                subtotal: Number(i.subtotal)
            })),
            subtotal: Number(s.subtotal),
            discount: Number(s.discount),
            total: Number(s.total),
            paymentMethod: s.payment_method,
            amountPaid: Number(s.amount_paid),
            change: Number(s.change_amount)
        }));
    },

    async recordSale(cart, paymentDetails, cashierName) {
        const now = new Date();
        const YYYY = now.getFullYear();
        const MM = String(now.getMonth() + 1).padStart(2, '0');
        const DD = String(now.getDate()).padStart(2, '0');

        const { count } = await db()
            .from('sales')
            .select('*', { count: 'exact', head: true });
        const seq = String((count || 0) + 1).padStart(4, '0');
        const txnNumber = `TXN-${YYYY}${MM}${DD}-${seq}`;

        const { data: sale, error: saleErr } = await db()
            .from('sales')
            .insert({
                txn_number: txnNumber,
                cashier_name: cashierName || 'Staff',
                payment_method: paymentDetails.method,
                subtotal: paymentDetails.subtotal,
                discount: paymentDetails.discount,
                total: paymentDetails.total,
                amount_paid: paymentDetails.amountPaid,
                change_amount: paymentDetails.change,
                sold_at: now.toISOString()
            })
            .select()
            .single();
        if (saleErr) throw saleErr;

        const items = cart.map(i => {
            const gross = i.qty * i.price;
            let discAmt = 0;
            if (i.discountType === 'percent') {
                discAmt = gross * ((i.discountValue || 0) / 100);
            } else if (i.discountType === 'amount') {
                discAmt = i.discountValue || 0;
            }
            discAmt = Math.min(Math.max(discAmt, 0), gross);
            return {
                sale_id: sale.id,
                product_id: i.id,
                product_name: i.name,
                qty: i.qty,
                unit_price: i.price,
                subtotal: gross - discAmt
            };
        });

        const { error: itemsErr } = await db().from('sale_items').insert(items);
        if (itemsErr) throw itemsErr;

        await ProductLogic.deductStockForSale(cart);

        return {
            id: txnNumber,
            date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            cashier: cashierName || 'Staff',
            total: paymentDetails.total,
            paymentMethod: paymentDetails.method
        };
    }
};

/* ==========================================================================
   4. POS USER INTERFACE MODULE
   ========================================================================== */
const POS = {
    cart: [],
    selectedPaymentMethod: 'CASH',
    currentCashier: null,

    init() {
        POS.renderProducts();
        POS.renderCart();

        document.getElementById('posSearch').addEventListener('input', (e) => {
            POS.renderProducts(e.target.value.trim().toLowerCase());
        });

        document.getElementById('posSearch').addEventListener('keypress', async (e) => {
            if (e.key === 'Enter') {
                const query = e.target.value.trim().toLowerCase();
                if (!query) return;
                const products = (await ProductLogic.getAll()).filter(p => p.status === 'Active');
                const matched = products.find(p =>
                    (p.sku && p.sku.toLowerCase() === query) ||
                    (p.barcode && p.barcode.toLowerCase() === query) ||
                    p.name.toLowerCase().includes(query)
                );
                if (matched) {
                    await POS.addToCart(matched.id);
                    e.target.value = '';
                    POS.renderProducts();
                } else {
                    showToast('No matching available product found');
                }
            }
        });
    },

    setCashier(name) {
        POS.currentCashier = name;
        const badge = document.getElementById('currentStaffBadge');
        if (name) {
            badge.textContent = 'Cashier: ' + name;
            badge.classList.add('visible');
        } else {
            badge.classList.remove('visible');
        }
    },

    async renderProducts(filter = '') {
        const grid = document.getElementById('posProductGrid');
        const products = (await ProductLogic.getAll()).filter(p => p.status === 'Active');

        const filtered = products.filter(p =>
            p.name.toLowerCase().includes(filter) ||
            (p.sku && p.sku.toLowerCase().includes(filter)) ||
            (p.barcode && p.barcode.toLowerCase().includes(filter))
        );

        if (filtered.length === 0) {
            grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 2rem;">No available products found</div>`;
            return;
        }

        grid.innerHTML = filtered.map(p => {
            const isOut = p.stock <= 0;
            const specLine = [p.design, p.size, p.color].filter(Boolean).join(' | ');
            return `
                <div class="product-card ${isOut ? 'out-of-stock' : ''}" onclick="POS.addToCart('${p.id}')">
                    <div>
                        <div class="p-name">${p.name}</div>
                        <div class="p-meta">${specLine || '—'}</div>
                    </div>
                    <div class="p-price-stock">
                        <span class="p-price">₱${p.price.toFixed(2)}</span>
                        <span class="p-stock">${isOut ? 'Out of Stock' : p.stock + ' in stock'}</span>
                    </div>
                </div>
            `;
        }).join('');
    },

    async addToCart(productId) {
        const product = await ProductLogic.getById(productId);
        if (!product || product.status !== 'Active') {
            showToast('This product is not available');
            return;
        }

        const cartItem = POS.cart.find(item => item.id === productId);
        const currentQty = cartItem ? cartItem.qty : 0;

        if (currentQty + 1 > product.stock) {
            showToast(`ERROR: Only ${product.stock} items available in stock!`);
            return;
        }

        if (cartItem) {
            cartItem.qty += 1;
        } else {
            POS.cart.push({ ...product, qty: 1, discountType: 'percent', discountValue: 0 });
        }

        POS.renderCart();
    },

    async updateQty(productId, delta) {
        const cartItem = POS.cart.find(item => item.id === productId);
        if (!cartItem) return;

        const product = await ProductLogic.getById(productId);
        const newQty = cartItem.qty + delta;

        if (newQty > product.stock) {
            showToast(`ERROR: Only ${product.stock} items available in stock!`);
            return;
        }

        if (newQty <= 0) {
            POS.cart = POS.cart.filter(item => item.id !== productId);
        } else {
            cartItem.qty = newQty;
        }

        POS.renderCart();
    },

    clearCart() {
        POS.cart = [];
        POS.renderCart();
    },

    // Computes this line's gross (qty x price), discount amount, and net subtotal
    itemLineTotals(item) {
        const gross = item.qty * item.price;
        let discAmt = 0;
        if (item.discountType === 'percent') {
            discAmt = gross * ((item.discountValue || 0) / 100);
        } else if (item.discountType === 'amount') {
            discAmt = item.discountValue || 0;
        }
        discAmt = Math.min(Math.max(discAmt, 0), gross); // never discount below ₱0 or more than the line itself
        return { gross, discAmt, net: gross - discAmt };
    },

    cartTotals() {
        let subtotal = 0;
        let discount = 0;
        POS.cart.forEach(item => {
            const { gross, discAmt } = POS.itemLineTotals(item);
            subtotal += gross;
            discount += discAmt;
        });
        return { subtotal, discount, total: subtotal - discount };
    },

    cartItemTemplate(item) {
        const { gross, discAmt, net } = POS.itemLineTotals(item);
        return `
            <div class="cart-item" id="cartItem-${item.id}">
                <div class="cart-item-top">
                    <div class="cart-item-info">
                        <span class="cart-item-title">${item.name}</span>
                        <span class="cart-item-price">₱${item.price.toFixed(2)} each</span>
                    </div>
                    <div class="cart-item-controls">
                        <button class="qty-btn" onclick="POS.updateQty('${item.id}', -1)">-</button>
                        <span class="qty-display">${item.qty}</span>
                        <button class="qty-btn" onclick="POS.updateQty('${item.id}', 1)">+</button>
                    </div>
                </div>
                <div class="cart-item-discount-row">
                    <select class="discount-type-select" onchange="POS.setItemDiscountType('${item.id}', this.value)">
                        <option value="percent" ${item.discountType === 'percent' ? 'selected' : ''}>% off</option>
                        <option value="amount" ${item.discountType === 'amount' ? 'selected' : ''}>₱ off</option>
                    </select>
                    <input type="number" min="0" step="0.01" class="discount-value-input"
                        placeholder="0" value="${item.discountValue ? item.discountValue : ''}"
                        oninput="POS.setItemDiscountValue('${item.id}', this.value)">
                    <div class="cart-item-subtotal-wrap" id="cartItemSubtotalWrap-${item.id}">
                        ${discAmt > 0 ? `<span class="cart-item-original">₱${gross.toFixed(2)}</span>` : ''}
                        <span class="cart-item-subtotal">₱${net.toFixed(2)}</span>
                    </div>
                </div>
            </div>
        `;
    },

    setItemDiscountType(productId, type) {
        const item = POS.cart.find(i => i.id === productId);
        if (!item) return;
        item.discountType = type;
        POS.refreshItemSubtotal(productId);
        POS.updateCartTotalsDisplay();
    },

    setItemDiscountValue(productId, value) {
        const item = POS.cart.find(i => i.id === productId);
        if (!item) return;
        let val = parseFloat(value);
        if (isNaN(val) || val < 0) val = 0;
        if (item.discountType === 'percent' && val > 100) val = 100;
        item.discountValue = val;
        POS.refreshItemSubtotal(productId);
        POS.updateCartTotalsDisplay();
    },

    // Updates only the small subtotal display for one line, so the discount input keeps focus while typing
    refreshItemSubtotal(productId) {
        const item = POS.cart.find(i => i.id === productId);
        const wrap = document.getElementById(`cartItemSubtotalWrap-${productId}`);
        if (!item || !wrap) return;
        const { gross, discAmt, net } = POS.itemLineTotals(item);
        wrap.innerHTML = `
            ${discAmt > 0 ? `<span class="cart-item-original">₱${gross.toFixed(2)}</span>` : ''}
            <span class="cart-item-subtotal">₱${net.toFixed(2)}</span>
        `;
    },

    updateCartTotalsDisplay() {
        const totals = POS.cartTotals();
        document.getElementById('posSubtotal').innerText = totals.subtotal.toFixed(2);
        document.getElementById('posDiscount').innerText = totals.discount.toFixed(2);
        document.getElementById('posTotal').innerText = totals.total.toFixed(2);
    },

    renderCart() {
        const list = document.getElementById('cartItemsList');
        if (POS.cart.length === 0) {
            list.innerHTML = `<div style="text-align: center; color: var(--text-muted); margin-auto: auto; padding: 2rem;">Cart is empty</div>`;
            document.getElementById('posSubtotal').innerText = '0.00';
            document.getElementById('posDiscount').innerText = '0.00';
            document.getElementById('posTotal').innerText = '0.00';
            return;
        }

        list.innerHTML = POS.cart.map(item => POS.cartItemTemplate(item)).join('');
        POS.updateCartTotalsDisplay();
    },

    openPaymentModal() {
        if (POS.cart.length === 0) {
            showToast('Cart is empty! Add products first.');
            return;
        }

        const totals = POS.cartTotals();
        document.getElementById('payModalTotal').innerText = totals.total.toFixed(2);
        document.getElementById('payAmountReceived').value = '';
        document.getElementById('payChange').innerText = '0.00';
        POS.setPaymentMethod('CASH');
        document.getElementById('paymentModal').classList.add('active');
    },

    closePaymentModal() {
        document.getElementById('paymentModal').classList.remove('active');
    },

    setPaymentMethod(method) {
        POS.selectedPaymentMethod = method;
        document.getElementById('btnPayCash').classList.toggle('active', method === 'CASH');
        document.getElementById('btnPayCard').classList.toggle('active', method === 'CARD');
        document.getElementById('cashFields').style.display = method === 'CASH' ? 'block' : 'none';
    },

    calculateChange() {
        const total = parseFloat(document.getElementById('payModalTotal').innerText);
        const received = parseFloat(document.getElementById('payAmountReceived').value || 0);
        const change = received - total;
        document.getElementById('payChange').innerText = change > 0 ? change.toFixed(2) : '0.00';
    },

    async finalizeSale() {
        const totals = POS.cartTotals();
        const total = totals.total;
        let amountPaid = total;
        let change = 0;

        if (POS.selectedPaymentMethod === 'CASH') {
            amountPaid = parseFloat(document.getElementById('payAmountReceived').value || 0);
            if (amountPaid < total) {
                showToast('ERROR: Amount received is less than total price!');
                return;
            }
            change = amountPaid - total;
        }

        try {
            const txn = await SalesLogic.recordSale(POS.cart, {
                method: POS.selectedPaymentMethod,
                subtotal: totals.subtotal,
                discount: totals.discount,
                total: total,
                amountPaid: amountPaid,
                change: change
            }, POS.currentCashier || 'Staff');

            showToast(`Sale Completed! TXN: ${txn.id}`);
            POS.closePaymentModal();
            POS.clearCart();
            await POS.renderProducts();
        } catch (err) {
            console.error(err);
            showToast('Sale failed: ' + (err.message || 'Unknown error'));
        }
    }
};

/* ==========================================================================
   5. OWNER / ADMIN USER INTERFACE MODULE
   ========================================================================== */
const Admin = {
    activeStockProductId: null,

    async refresh() {
        await Admin.renderDashboard();
        await Admin.renderProducts();
        await Admin.renderInventory();
        await Admin.renderSales();
        await Admin.renderStaff();
    },

    // Local YYYY-MM-DD key used to group sales by calendar day (avoids UTC off-by-one issues)
    dayKey(d) {
        return d.toLocaleDateString('en-CA');
    },

    async renderDashboard() {
        const [sales, products] = await Promise.all([SalesLogic.getAll(), ProductLogic.getAll()]);
        const now = new Date();

        const dateLabel = document.getElementById('dashDateLabel');
        if (dateLabel) {
            dateLabel.innerText = now.toLocaleDateString('en-US', {
                weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
            });
        }

        // ---- Today vs yesterday stats ----
        const todayKey = Admin.dayKey(now);
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        const yesterdayKey = Admin.dayKey(yesterday);

        const todaySales = sales.filter(s => Admin.dayKey(new Date(s.rawDate)) === todayKey);
        const yesterdaySales = sales.filter(s => Admin.dayKey(new Date(s.rawDate)) === yesterdayKey);

        const totalRev = todaySales.reduce((sum, s) => sum + s.total, 0);
        const yesterdayRev = yesterdaySales.reduce((sum, s) => sum + s.total, 0);
        const avgSale = todaySales.length ? totalRev / todaySales.length : 0;

        document.getElementById('dashTodaySales').innerText = `₱${totalRev.toFixed(2)}`;
        document.getElementById('dashTxnCount').innerText = todaySales.length;
        document.getElementById('dashAvgSale').innerText = `₱${avgSale.toFixed(2)}`;
        document.getElementById('dashProductCount').innerText = products.length;

        const trendEl = document.getElementById('dashSalesTrend');
        if (trendEl) {
            if (yesterdayRev > 0) {
                const pct = ((totalRev - yesterdayRev) / yesterdayRev) * 100;
                const up = pct >= 0;
                trendEl.innerHTML = `<span class="${up ? 'trend-up' : 'trend-down'}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}% vs yesterday</span>`;
            } else if (totalRev > 0) {
                trendEl.innerHTML = `<span class="trend-up">▲ New sales today</span>`;
            } else {
                trendEl.innerHTML = '';
            }
        }

        // ---- Stock alerts ----
        const lowStock = products.filter(p => p.status === 'Active' && p.stock > 0 && p.stock <= p.minStock);
        const outStock = products.filter(p => p.status === 'Active' && p.stock <= 0);
        document.getElementById('dashLowStockCount').innerText = lowStock.length;
        document.getElementById('dashOutStockCount').innerText = outStock.length;

        const alertListEl = document.getElementById('stockAlertList');
        const alertItems = [
            ...outStock.map(p => ({ ...p, level: 'out' })),
            ...lowStock.map(p => ({ ...p, level: 'low' }))
        ].sort((a, b) => a.stock - b.stock).slice(0, 6);

        if (alertItems.length === 0) {
            alertListEl.innerHTML = `<div class="empty-alert">✅ All stock levels are healthy</div>`;
        } else {
            alertListEl.innerHTML = alertItems.map(p => `
                <div class="alert-row ${p.level}">
                    <div class="alert-info">
                        <strong>${p.name}</strong>
                        <span>${p.stock} in stock · min ${p.minStock}</span>
                    </div>
                    <span class="alert-badge ${p.level}">${p.level === 'out' ? 'Out of Stock' : 'Low Stock'}</span>
                </div>
            `).join('');
        }

        // ---- 7-day sales trend chart ----
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(now.getDate() - i);
            days.push(d);
        }
        const dayTotals = days.map(d => {
            const key = Admin.dayKey(d);
            const revenue = sales
                .filter(s => Admin.dayKey(new Date(s.rawDate)) === key)
                .reduce((sum, s) => sum + s.total, 0);
            return { date: d, revenue };
        });
        const maxRev = Math.max(...dayTotals.map(d => d.revenue), 1);

        const chartEl = document.getElementById('salesTrendChart');
        chartEl.innerHTML = `<div class="bar-chart">${dayTotals.map(d => {
            const heightPct = d.revenue > 0 ? Math.max((d.revenue / maxRev) * 100, 4) : 0;
            const isToday = Admin.dayKey(d.date) === todayKey;
            return `
                <div class="bar-col">
                    <span class="bar-value">${d.revenue > 0 ? '₱' + Admin.compactPeso(d.revenue) : ''}</span>
                    <div class="bar-track">
                        <div class="bar-fill${isToday ? ' today' : ''}" style="height:${heightPct}%"></div>
                    </div>
                    <span class="bar-label${isToday ? ' today' : ''}">${d.date.toLocaleDateString('en-US', { weekday: 'short' })}</span>
                </div>
            `;
        }).join('')}</div>`;

        // ---- Top selling products ----
        const productById = {};
        products.forEach(p => { productById[p.id] = p; });

        const salesMap = {};
        sales.forEach(s => {
            s.items.forEach(item => {
                if (!salesMap[item.id]) {
                    const matched = productById[item.id];
                    salesMap[item.id] = {
                        name: item.name,
                        sku: (matched && (matched.sku || matched.barcode)) || '—',
                        qty: 0,
                        revenue: 0
                    };
                }
                salesMap[item.id].qty += item.qty;
                salesMap[item.id].revenue += item.subtotal;
            });
        });

        const topSellers = Object.values(salesMap)
            .sort((a, b) => b.qty - a.qty)
            .slice(0, 5);

        const topTbody = document.getElementById('topSellingTable');
        if (topSellers.length === 0) {
            topTbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">No sales data recorded yet</td></tr>`;
        } else {
            topTbody.innerHTML = topSellers.map(s => `
                <tr>
                    <td><strong>${s.name}</strong></td>
                    <td>${s.sku}</td>
                    <td>${s.qty}</td>
                    <td>₱${s.revenue.toFixed(2)}</td>
                </tr>
            `).join('');
        }
    },

    compactPeso(n) {
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
        return n.toFixed(0);
    },

    async renderProducts() {
        const products = await ProductLogic.getAll();
        const tbody = document.getElementById('adminProductsTable');

        if (products.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No products created yet</td></tr>`;
            return;
        }

        tbody.innerHTML = products.map(p => {
            const isAvailable = p.status === 'Active';
            const specLine = [p.category, p.design, p.size, p.color].filter(Boolean).join(' | ');
            return `
            <tr>
                <td>
                    <div class="product-info-cell">
                        <div class="product-info-main">
                            <strong>${p.name}</strong>
                            <span class="sep">|</span>
                            <span class="product-barcode">${p.barcode || p.sku || '—'}</span>
                        </div>
                        <div class="product-info-sub">${specLine || '—'}</div>
                    </div>
                </td>
                <td>₱${p.price.toFixed(2)}</td>
                <td>₱${p.cost.toFixed(2)}</td>
                <td>
                    <button class="status-toggle ${isAvailable ? 'available' : 'unavailable'}"
                        onclick="Admin.toggleProductAvailability('${p.id}')"
                        title="Click to toggle availability">
                        ${isAvailable ? 'Available' : 'Not Available'}
                    </button>
                </td>
                <td>
                    <div class="actions-cell">
                        <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.8rem;" onclick="Admin.openEditProductModal('${p.id}')">Edit</button>
                        <button class="btn-danger-outline" style="padding: 4px 8px; font-size: 0.8rem;" onclick="Admin.deleteProduct('${p.id}')">Delete</button>
                    </div>
                </td>
            </tr>
            `;
        }).join('');
    },

    async deleteProduct(id) {
        const p = await ProductLogic.getById(id);
        if (!p) {
            showToast('Product not found');
            return;
        }
        if (!confirm(`Delete "${p.name}"? This cannot be undone. Past sales records will keep the product name but no longer link to this product.`)) {
            return;
        }
        try {
            await ProductLogic.deleteProduct(id);
            await Admin.refresh();
            await POS.renderProducts();
            showToast(`"${p.name}" deleted`);
        } catch (err) {
            showToast('Error deleting product: ' + err.message);
        }
    },

    async toggleProductAvailability(id) {
        try {
            await ProductLogic.toggleStatus(id);
            await Admin.refresh();
            await POS.renderProducts();
            const p = await ProductLogic.getById(id);
            showToast(p && p.status === 'Active' ? 'Product is now Available' : 'Product is now Not Available');
        } catch (err) {
            showToast('Error: ' + err.message);
        }
    },

    async renderInventory() {
        const products = await ProductLogic.getAll();
        const tbody = document.getElementById('adminInventoryTable');

        if (products.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No products created yet</td></tr>`;
            return;
        }

        tbody.innerHTML = products.map(p => {
            const isAvailable = p.status === 'Active';
            return `
            <tr>
                <td><strong>${p.name}</strong></td>
                <td>${p.barcode || p.sku || ''}</td>
                <td>₱${p.price.toFixed(2)}</td>
                <td>${p.stock}</td>
                <td>
                    <span class="badge ${isAvailable ? 'badge-success' : 'badge-danger'}">
                        ${isAvailable ? 'Available' : 'Not Available'}
                    </span>
                </td>
                <td>
                    <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.8rem; margin-right:4px;" onclick="Admin.openAddStockModal('${p.id}')">+ Stock</button>
                    <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.8rem;" onclick="Admin.openEditProductModal('${p.id}')">Edit</button>
                </td>
            </tr>
            `;
        }).join('');
    },

    async renderSales() {
        const sales = await SalesLogic.getAll();
        const tbody = document.getElementById('adminSalesTable');

        if (sales.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No transactions completed yet</td></tr>`;
            return;
        }

        tbody.innerHTML = sales.map(s => `
            <tr>
                <td><strong>${s.id}</strong></td>
                <td>${s.date} ${s.time}</td>
                <td>${s.cashier}</td>
                <td><span class="badge badge-success">${s.paymentMethod}</span></td>
                <td>${s.items.map(i => `${i.name} (x${i.qty})`).join(', ')}</td>
                <td>${s.discount > 0 ? `<span class="badge badge-danger">-₱${s.discount.toFixed(2)}</span>` : '—'}</td>
                <td><strong>₱${s.total.toFixed(2)}</strong></td>
            </tr>
        `).join('');
    },

    async renderStaff() {
        const staff = await StaffLogic.getAll();
        const tbody = document.getElementById('adminStaffTable');

        if (staff.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">No staff registered yet. Click "+ Register Staff" to add names.</td></tr>`;
            return;
        }

        tbody.innerHTML = staff.map(s => {
            const regDate = s.registeredAt
                ? new Date(s.registeredAt).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric'
                })
                : '-';
            return `
            <tr>
                <td><strong>${s.name}</strong></td>
                <td>
                    <button class="status-toggle ${s.active ? 'available' : 'unavailable'}"
                        onclick="Admin.toggleStaffActive('${s.id}')"
                        title="Click to toggle active status">
                        ${s.active ? 'Active' : 'Inactive'}
                    </button>
                </td>
                <td>${regDate}</td>
                <td>
                    <button class="btn-danger-outline" style="padding: 4px 8px;" onclick="Admin.removeStaff('${s.id}')">Remove</button>
                </td>
            </tr>
            `;
        }).join('');
    },

    openAddStaffModal() {
        document.getElementById('staffNameInput').value = '';
        document.getElementById('staffModal').classList.add('active');
        setTimeout(() => document.getElementById('staffNameInput').focus(), 50);
    },

    closeStaffModal() {
        document.getElementById('staffModal').classList.remove('active');
    },

    async saveStaff() {
        const name = document.getElementById('staffNameInput').value;
        const result = await StaffLogic.add(name);
        if (!result.ok) {
            showToast(result.message);
            return;
        }
        Admin.closeStaffModal();
        await Admin.renderStaff();
        showToast('Staff registered successfully!');
    },

    async toggleStaffActive(id) {
        try {
            await StaffLogic.toggleActive(id);
            await Admin.renderStaff();
            const s = await StaffLogic.getById(id);
            showToast(s && s.active ? `${s.name} is now Active` : `${s ? s.name : 'Staff'} is now Inactive`);
        } catch (err) {
            showToast('Error: ' + err.message);
        }
    },

    async removeStaff(id) {
        const s = await StaffLogic.getById(id);
        if (!s) return;
        if (!confirm(`Remove staff member "${s.name}"?`)) return;
        try {
            await StaffLogic.remove(id);
            await Admin.renderStaff();
            showToast('Staff removed');
        } catch (err) {
            showToast('Error: ' + err.message);
        }
    },

    openAddProductModal() {
        document.getElementById('productModalTitle').innerText = 'Add New Product';
        document.getElementById('productForm').reset();
        document.getElementById('pId').value = '';
        document.getElementById('pSku').value = '';
        document.getElementById('pBarcode').value = '';
        document.getElementById('pCodeDescription').textContent = 'Enter Category, Design, Size and Color to generate the code';
        document.getElementById('productModal').classList.add('active');
    },

    async openEditProductModal(id) {
        const p = await ProductLogic.getById(id);
        if (!p) return;

        document.getElementById('productModalTitle').innerText = 'Edit Product';
        document.getElementById('pId').value = p.id;
        document.getElementById('pName').value = p.name;
        document.getElementById('pSku').value = p.sku || p.barcode || '';
        document.getElementById('pBarcode').value = p.barcode || p.sku || '';
        document.getElementById('pCategory').value = p.category || '';
        document.getElementById('pDesign').value = p.design || '';
        document.getElementById('pSize').value = p.size || '';
        document.getElementById('pColor').value = p.color || '';
        document.getElementById('pCodeDescription').textContent = [p.category, p.design, p.size, p.color].filter(Boolean).join('-')
            ? `Zeno Bear-${[p.category, p.design, p.size, p.color].filter(Boolean).join('-')}`
            : 'Automatic code';
        document.getElementById('pPrice').value = p.price;
        document.getElementById('pCost').value = p.cost;

        document.getElementById('productModal').classList.add('active');
    },

    closeProductModal() {
        document.getElementById('productModal').classList.remove('active');
    },

    generateProductCode() {
        const category = document.getElementById('pCategory').value.trim();
        const design = document.getElementById('pDesign').value.trim();
        const size = document.getElementById('pSize').value.trim();
        const color = document.getElementById('pColor').value.trim();

        const categoryCode = Admin.toCategoryCode(category);
        const designCode = Admin.toDesignCode(design);
        const sizeCode = Admin.toSizeCode(size);
        const colorCode = Admin.toColorCode(color);

        const parts = [categoryCode, designCode, sizeCode, colorCode];
        const complete = parts.every(Boolean);
        const code = complete ? `ZB-${parts.join('-')}` : '';
        const description = [category, design, size, color].filter(Boolean).join('-');

        document.getElementById('pSku').value = code;
        document.getElementById('pBarcode').value = code;
        document.getElementById('pCodeDescription').textContent = description
            ? `Zeno Bear-${description}`
            : 'Enter Category, Design, Size and Color to generate the code';
    },

    toCategoryCode(value) {
        const v = value.trim().toUpperCase();
        if (!v) return '';
        const words = v.replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
        return words.length > 1 ? words.map(w => w[0]).join('').slice(0, 4) : v.slice(0, 4);
    },

    toDesignCode(value) {
        const v = value.trim().toUpperCase();
        if (!v) return '';
        const match = v.match(/(?:DESIGN\s*)?(\d{1,3})/i);
        if (match) return `D${String(match[1]).padStart(2, '0')}`;
        const letters = v.replace(/[^A-Z]/g, '');
        return `D${letters.slice(0, 3)}`;
    },

    toSizeCode(value) {
        const v = value.trim().toUpperCase();
        const map = {
            'EXTRA SMALL': 'XS', 'X-SMALL': 'XS', 'SMALL': 'S', 'MEDIUM': 'M',
            'LARGE': 'L', 'EXTRA LARGE': 'XL', 'X-LARGE': 'XL', 'XXL': 'XXL',
            '2XL': '2XL', '3XL': '3XL', '4XL': '4XL', '5XL': '5XL'
        };
        return map[v] || v.replace(/[^A-Z0-9]/g, '').slice(0, 4);
    },

    toColorCode(value) {
        const v = value.trim().toUpperCase();
        const map = {
            'BLACK': 'BLK', 'WHITE': 'WHT', 'RED': 'RED', 'BLUE': 'BLU',
            'GREEN': 'GRN', 'YELLOW': 'YLW', 'PINK': 'PNK', 'PURPLE': 'PUR',
            'ORANGE': 'ORG', 'BROWN': 'BRN', 'GRAY': 'GRY', 'GREY': 'GRY',
            'BEIGE': 'BEG', 'CREAM': 'CRM', 'NAVY': 'NVY', 'MAROON': 'MRN'
        };
        return map[v] || v.replace(/[^A-Z0-9]/g, '').slice(0, 4);
    },

    async saveProduct(e) {
        e.preventDefault();
        Admin.generateProductCode();
        const generatedCode = document.getElementById('pSku').value;
        if (!generatedCode) {
            showToast('Please complete Category, Design, Size and Color!');
            return;
        }

        const existingId = document.getElementById('pId').value || null;
        let existingProduct = null;
        if (existingId) {
            existingProduct = await ProductLogic.getById(existingId);
        }

        const productData = {
            id: existingId,
            name: document.getElementById('pName').value,
            sku: generatedCode,
            barcode: generatedCode,
            category: document.getElementById('pCategory').value,
            design: document.getElementById('pDesign').value,
            size: document.getElementById('pSize').value,
            color: document.getElementById('pColor').value,
            price: parseFloat(document.getElementById('pPrice').value),
            cost: parseFloat(document.getElementById('pCost').value || 0),
            stock: existingProduct?.stock ?? 0,
            minStock: existingProduct?.minStock ?? 0,
            status: existingProduct?.status ?? 'Active'
        };

        try {
            await ProductLogic.saveProduct(productData);
            Admin.closeProductModal();
            await Admin.refresh();
            await POS.renderProducts();
            showToast('Product saved successfully!');
        } catch (err) {
            console.error(err);
            showToast('Error saving product: ' + err.message);
        }
    },

    async openAddStockModal(id) {
        const p = await ProductLogic.getById(id);
        if (!p) return;
        Admin.activeStockProductId = id;
        document.getElementById('stockModalProdName').innerText = `Add stock for: ${p.name} (Current Stock: ${p.stock})`;
        document.getElementById('stockAddQty').value = '';
        document.getElementById('stockModal').classList.add('active');
    },

    closeStockModal() {
        document.getElementById('stockModal').classList.remove('active');
    },

    async submitAddStock() {
        const qty = parseInt(document.getElementById('stockAddQty').value || 0, 10);
        if (qty <= 0) {
            showToast('Please enter a valid stock quantity!');
            return;
        }
        try {
            await ProductLogic.addStock(Admin.activeStockProductId, qty);
            Admin.closeStockModal();
            await Admin.refresh();
            await POS.renderProducts();
            showToast('Stock added successfully!');
        } catch (err) {
            showToast('Error: ' + err.message);
        }
    }
};

/* ==========================================================================
   6. NAVIGATION & SYSTEM CONTROLLERS
   ========================================================================== */
function switchMainView(view) {
    if (view === 'admin' &&
        !document.getElementById('adminAccessModal').classList.contains('active') &&
        document.body.classList.contains('role-selection-active') === false &&
        !RoleAccess.adminSession) {
        RoleAccess.requestAdminAccess();
        return;
    }

    document.getElementById('btnPosNav').classList.toggle('active', view === 'pos');
    document.getElementById('btnAdminNav').classList.toggle('active', view === 'admin');

    document.getElementById('posView').classList.toggle('active', view === 'pos');
    document.getElementById('adminView').classList.toggle('active', view === 'admin');

    if (view === 'admin') {
        Admin.refresh();
    } else if (view === 'pos') {
        POS.renderProducts();
    }
}

function switchAdminTab(tabName) {
    document.querySelectorAll('.admin-menu-item').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.querySelector(`.admin-menu-item[data-tab="${tabName}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    document.querySelectorAll('.admin-tab-pane').forEach(pane => pane.classList.remove('active'));

    const targetPaneMap = {
        'dashboard': 'tabDashboard',
        'products': 'tabProducts',
        'inventory': 'tabInventory',
        'sales': 'tabSales',
        'staff': 'tabStaff'
    };

    document.getElementById(targetPaneMap[tabName]).classList.add('active');
    Admin.refresh();
}

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.innerText = message;
    toast.style.display = 'block';
    setTimeout(() => {
        toast.style.display = 'none';
    }, 3000);
}

/* ==========================================================================
   7. ROLE ACCESS CONTROLLER
   ========================================================================== */
const RoleAccess = {
    // Change this password before production use.
    // This is front-end only and NOT secure authentication.
    ADMIN_PASSWORD: 'admin123',
    adminSession: false,
    selectedStaffName: null,
    staffHighlightIndex: -1,

    showAdminLogin() {
        document.getElementById('roleOptions').style.display = 'none';
        document.getElementById('staffSelectPanel').classList.remove('active');
        document.getElementById('adminLoginPanel').classList.add('active');
        document.getElementById('adminPassword').value = '';
        document.getElementById('adminLoginError').style.display = 'none';
        setTimeout(() => document.getElementById('adminPassword').focus(), 50);
    },

    showStaffSelect() {
        document.getElementById('roleOptions').style.display = 'none';
        document.getElementById('adminLoginPanel').classList.remove('active');
        document.getElementById('staffSelectPanel').classList.add('active');
        document.getElementById('staffSearchInput').value = '';
        document.getElementById('staffSelectError').style.display = 'none';
        RoleAccess.selectedStaffName = null;
        document.getElementById('selectedStaffPreview').classList.remove('visible');
        document.getElementById('staffSuggestions').classList.remove('visible');
        RoleAccess.staffHighlightIndex = -1;
        setTimeout(() => document.getElementById('staffSearchInput').focus(), 50);
    },

    backToRoles() {
        document.getElementById('roleOptions').style.display = 'grid';
        document.getElementById('adminLoginPanel').classList.remove('active');
        document.getElementById('staffSelectPanel').classList.remove('active');
        document.getElementById('adminPassword').value = '';
        document.getElementById('adminLoginError').style.display = 'none';
        document.getElementById('staffSelectError').style.display = 'none';
        document.getElementById('staffSearchInput').value = '';
        RoleAccess.selectedStaffName = null;
    },

    async filterStaffSuggestions() {
        const input = document.getElementById('staffSearchInput');
        const query = input.value.trim().toLowerCase();
        const box = document.getElementById('staffSuggestions');
        const activeStaff = await StaffLogic.getActive();

        RoleAccess.staffHighlightIndex = -1;
        RoleAccess.selectedStaffName = null;
        document.getElementById('selectedStaffPreview').classList.remove('visible');
        document.getElementById('staffSelectError').style.display = 'none';

        if (!query) {
            box.classList.remove('visible');
            box.innerHTML = '';
            return;
        }

        const matches = activeStaff.filter(s =>
            s.name.toLowerCase().startsWith(query) ||
            s.name.toLowerCase().includes(query)
        );

        matches.sort((a, b) => {
            const aStart = a.name.toLowerCase().startsWith(query) ? 0 : 1;
            const bStart = b.name.toLowerCase().startsWith(query) ? 0 : 1;
            if (aStart !== bStart) return aStart - bStart;
            return a.name.localeCompare(b.name);
        });

        if (matches.length === 0) {
            box.innerHTML = `<div class="staff-suggestion-empty">No active staff matching "${input.value.trim()}"</div>`;
            box.classList.add('visible');
            return;
        }

        box.innerHTML = matches.map((s, idx) =>
            `<div class="staff-suggestion-item" data-name="${s.name}" data-idx="${idx}" onclick="RoleAccess.pickStaff('${s.name.replace(/'/g, "\\'")}')">${s.name}</div>`
        ).join('');
        box.classList.add('visible');
    },

    handleStaffSearchKey(event) {
        const box = document.getElementById('staffSuggestions');
        const items = box.querySelectorAll('.staff-suggestion-item');
        if (!box.classList.contains('visible') || items.length === 0) {
            if (event.key === 'Enter') {
                event.preventDefault();
                RoleAccess.confirmStaffSelect();
            }
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            RoleAccess.staffHighlightIndex = Math.min(RoleAccess.staffHighlightIndex + 1, items.length - 1);
            RoleAccess.updateStaffHighlight(items);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            RoleAccess.staffHighlightIndex = Math.max(RoleAccess.staffHighlightIndex - 1, 0);
            RoleAccess.updateStaffHighlight(items);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (RoleAccess.staffHighlightIndex >= 0 && items[RoleAccess.staffHighlightIndex]) {
                const name = items[RoleAccess.staffHighlightIndex].getAttribute('data-name');
                RoleAccess.pickStaff(name);
            } else if (items.length === 1) {
                RoleAccess.pickStaff(items[0].getAttribute('data-name'));
            } else {
                RoleAccess.confirmStaffSelect();
            }
        } else if (event.key === 'Escape') {
            box.classList.remove('visible');
        }
    },

    updateStaffHighlight(items) {
        items.forEach((el, i) => {
            el.classList.toggle('highlighted', i === RoleAccess.staffHighlightIndex);
        });
    },

    pickStaff(name) {
        RoleAccess.selectedStaffName = name;
        document.getElementById('staffSearchInput').value = name;
        document.getElementById('staffSuggestions').classList.remove('visible');
        const preview = document.getElementById('selectedStaffPreview');
        preview.textContent = 'Selected: ' + name;
        preview.classList.add('visible');
        document.getElementById('staffSelectError').style.display = 'none';
    },

    async confirmStaffSelect() {
        const inputVal = document.getElementById('staffSearchInput').value.trim();
        let name = RoleAccess.selectedStaffName;

        if (!name && inputVal) {
            const active = await StaffLogic.getActive();
            const match = active.find(s => s.name.toLowerCase() === inputVal.toLowerCase());
            if (match) name = match.name;
        }

        if (!name) {
            document.getElementById('staffSelectError').style.display = 'block';
            return;
        }

        const stillActive = (await StaffLogic.getActive()).some(s => s.name === name);
        if (!stillActive) {
            document.getElementById('staffSelectError').textContent = 'This staff member is no longer active.';
            document.getElementById('staffSelectError').style.display = 'block';
            return;
        }

        POS.setCashier(name);
        RoleAccess.openSystem('staff');
    },

    requestAdminAccess() {
        if (document.getElementById('adminView').classList.contains('active')) return;

        const modal = document.getElementById('adminAccessModal');
        const input = document.getElementById('switchAdminPassword');
        const error = document.getElementById('switchAdminError');

        input.value = '';
        error.style.display = 'none';
        modal.classList.add('active');
        setTimeout(() => input.focus(), 50);
    },

    closeSwitchAdmin() {
        document.getElementById('adminAccessModal').classList.remove('active');
        document.getElementById('switchAdminPassword').value = '';
        document.getElementById('switchAdminError').style.display = 'none';
    },

    loginFromSwitch() {
        const input = document.getElementById('switchAdminPassword');
        const error = document.getElementById('switchAdminError');

        if (input.value === RoleAccess.ADMIN_PASSWORD) {
            RoleAccess.adminSession = true;
            RoleAccess.closeSwitchAdmin();
            switchMainView('admin');
        } else {
            error.style.display = 'block';
            input.select();
            input.focus();
        }
    },

    loginAdmin() {
        const password = document.getElementById('adminPassword').value;

        if (password === RoleAccess.ADMIN_PASSWORD) {
            RoleAccess.adminSession = true;
            RoleAccess.openSystem('admin');
        } else {
            document.getElementById('adminLoginError').style.display = 'block';
            document.getElementById('adminPassword').focus();
        }
    },

    openSystem(role) {
        if (role !== 'admin') {
            RoleAccess.adminSession = false;
        }

        const gate = document.getElementById('roleGate');
        gate.classList.add('hidden');
        document.body.classList.remove('role-selection-active');

        if (role === 'admin') {
            switchMainView('admin');
        } else {
            switchMainView('pos');
        }
    }
};

// Initialize application on page load
window.addEventListener('DOMContentLoaded', () => {
    // Quick check that Supabase keys were replaced
    if (SUPABASE_URL.includes('YOUR_PROJECT_REF') || SUPABASE_ANON_KEY.includes('YOUR_')) {
        console.warn('⚠️ Replace SUPABASE_URL and SUPABASE_ANON_KEY in app.js with your real project values.');
        showToast('Configure Supabase URL and key in app.js');
    }
    POS.init();
});
