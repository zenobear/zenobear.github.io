/* ==========================================================================
   1. DATA LAYER (ABSTRACTED STORAGE MODULE)
   Designed for seamless future upgrade from LocalStorage to Firebase Firestore
   ========================================================================== */
const DB = {
    get: (key) => JSON.parse(localStorage.getItem(key) || '[]'),
    set: (key, data) => localStorage.setItem(key, JSON.stringify(data)),
    
    initSeedData: () => {
        if (!localStorage.getItem('products')) {
            const defaultProducts = [
                { id: 'p1', name: 'Zeno Bear Onesie', sku: 'ZB-001', barcode: '123456789', category: 'Baby Clothing', price: 450, cost: 250, stock: 25, minStock: 5, status: 'Active' },
                { id: 'p2', name: 'Classic T-Shirt', sku: 'TS-001', barcode: '111222333', category: 'Apparel', price: 350, cost: 180, stock: 15, minStock: 5, status: 'Active' },
                { id: 'p3', name: 'Casual Shorts', sku: 'SH-001', barcode: '444555666', category: 'Apparel', price: 450, cost: 220, stock: 4, minStock: 5, status: 'Active' },
                { id: 'p4', name: 'Snapback Cap', sku: 'CP-001', barcode: '777888999', category: 'Accessories', price: 300, cost: 120, stock: 0, minStock: 3, status: 'Active' }
            ];
            DB.set('products', defaultProducts);
        }
        if (!localStorage.getItem('sales')) {
            DB.set('sales', []);
        }
    }
};

/* ==========================================================================
   2. PRODUCT BUSINESS LOGIC MODULE
   ========================================================================== */
const ProductLogic = {
    getAll: () => DB.get('products'),
    
    saveAll: (products) => DB.set('products', products),

    getById: (id) => ProductLogic.getAll().find(p => p.id === id),

    saveProduct: (productData) => {
        const products = ProductLogic.getAll();
        if (productData.id) {
            // Update existing
            const idx = products.findIndex(p => p.id === productData.id);
            if (idx !== -1) products[idx] = { ...products[idx], ...productData };
        } else {
            // Create new
            productData.id = 'p_' + Date.now();
            products.push(productData);
        }
        ProductLogic.saveAll(products);
    },

    addStock: (id, qty) => {
        const products = ProductLogic.getAll();
        const p = products.find(prod => prod.id === id);
        if (p) {
            p.stock += parseInt(qty);
            ProductLogic.saveAll(products);
        }
    },

    toggleStatus: (id) => {
        const products = ProductLogic.getAll();
        const p = products.find(prod => prod.id === id);
        if (p) {
            p.status = p.status === 'Active' ? 'Inactive' : 'Active';
            ProductLogic.saveAll(products);
        }
    },

    deductStockForSale: (cart) => {
        const products = ProductLogic.getAll();
        cart.forEach(item => {
            const p = products.find(prod => prod.id === item.id);
            if (p) {
                p.stock -= item.qty;
            }
        });
        ProductLogic.saveAll(products);
    }
};

/* ==========================================================================
   3. SALES BUSINESS LOGIC MODULE
   ========================================================================== */
const SalesLogic = {
    getAll: () => DB.get('sales'),

    recordSale: (cart, paymentDetails) => {
        const sales = SalesLogic.getAll();
        
        // Generate TXN-YYYYMMDD-XXXX
        const now = new Date();
        const YYYY = now.getFullYear();
        const MM = String(now.getMonth() + 1).padStart(2, '0');
        const DD = String(now.getDate()).padStart(2, '0');
        const seq = String(sales.length + 1).padStart(4, '0');
        const txnNumber = `TXN-${YYYY}${MM}${DD}-${seq}`;

        const saleRecord = {
            id: txnNumber,
            date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            rawDate: now.toISOString(),
            cashier: 'Staff',
            items: cart.map(i => ({ id: i.id, name: i.name, qty: i.qty, price: i.price, subtotal: i.qty * i.price })),
            subtotal: paymentDetails.total,
            discount: 0,
            total: paymentDetails.total,
            paymentMethod: paymentDetails.method,
            amountPaid: paymentDetails.amountPaid,
            change: paymentDetails.change
        };

        sales.push(saleRecord);
        DB.set('sales', sales);

        // Deduct stock
        ProductLogic.deductStockForSale(cart);

        return saleRecord;
    }
};

/* ==========================================================================
   4. POS USER INTERFACE MODULE
   ========================================================================== */
const POS = {
    cart: [],
    selectedPaymentMethod: 'CASH',

    init: () => {
        POS.renderProducts();
        POS.renderCart();

        document.getElementById('posSearch').addEventListener('input', (e) => {
            POS.renderProducts(e.target.value.trim().toLowerCase());
        });

        document.getElementById('posSearch').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const query = e.target.value.trim().toLowerCase();
                if (!query) return;
                const products = ProductLogic.getAll().filter(p => p.status === 'Active');
                const matched = products.find(p => 
                    p.sku.toLowerCase() === query || 
                    p.barcode.toLowerCase() === query || 
                    p.name.toLowerCase().includes(query)
                );
                if (matched) {
                    POS.addToCart(matched.id);
                    e.target.value = '';
                    POS.renderProducts();
                } else {
                    showToast('No matching active product found');
                }
            }
        });
    },

    renderProducts: (filter = '') => {
        const grid = document.getElementById('posProductGrid');
        const products = ProductLogic.getAll().filter(p => p.status === 'Active');

        const filtered = products.filter(p => 
            p.name.toLowerCase().includes(filter) ||
            p.sku.toLowerCase().includes(filter) ||
            p.barcode.toLowerCase().includes(filter)
        );

        if (filtered.length === 0) {
            grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 2rem;">No active products found</div>`;
            return;
        }

        grid.innerHTML = filtered.map(p => {
            const isOut = p.stock <= 0;
            return `
                <div class="product-card ${isOut ? 'out-of-stock' : ''}" onclick="POS.addToCart('${p.id}')">
                    <div>
                        <div class="p-name">${p.name}</div>
                        <div class="p-meta">SKU: ${p.sku} | Barcode: ${p.barcode}</div>
                    </div>
                    <div class="p-price-stock">
                        <span class="p-price">₱${p.price.toFixed(2)}</span>
                        <span class="p-stock">${isOut ? 'Out of Stock' : p.stock + ' in stock'}</span>
                    </div>
                </div>
            `;
        }).join('');
    },

    addToCart: (productId) => {
        const product = ProductLogic.getById(productId);
        if (!product || product.status !== 'Active') return;

        const cartItem = POS.cart.find(item => item.id === productId);
        const currentQty = cartItem ? cartItem.qty : 0;

        if (currentQty + 1 > product.stock) {
            showToast(`ERROR: Only ${product.stock} items available in stock!`);
            return;
        }

        if (cartItem) {
            cartItem.qty += 1;
        } else {
            POS.cart.push({ ...product, qty: 1 });
        }

        POS.renderCart();
    },

    updateQty: (productId, delta) => {
        const cartItem = POS.cart.find(item => item.id === productId);
        if (!cartItem) return;

        const product = ProductLogic.getById(productId);
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

    clearCart: () => {
        POS.cart = [];
        POS.renderCart();
    },

    renderCart: () => {
        const list = document.getElementById('cartItemsList');
        if (POS.cart.length === 0) {
            list.innerHTML = `<div style="text-align: center; color: var(--text-muted); margin-auto: auto; padding: 2rem;">Cart is empty</div>`;
            document.getElementById('posSubtotal').innerText = '0.00';
            document.getElementById('posTotal').innerText = '0.00';
            return;
        }

        let subtotal = 0;
        list.innerHTML = POS.cart.map(item => {
            const itemSubtotal = item.qty * item.price;
            subtotal += itemSubtotal;
            return `
                <div class="cart-item">
                    <div class="cart-item-info">
                        <span class="cart-item-title">${item.name}</span>
                        <span class="cart-item-price">₱${item.price.toFixed(2)} each</span>
                    </div>
                    <div class="cart-item-controls">
                        <button class="qty-btn" onclick="POS.updateQty('${item.id}', -1)">-</button>
                        <span style="font-weight:700; width: 20px; text-align:center;">${item.qty}</span>
                        <button class="qty-btn" onclick="POS.updateQty('${item.id}', 1)">+</button>
                    </div>
                    <div class="cart-item-subtotal">₱${itemSubtotal.toFixed(2)}</div>
                </div>
            `;
        }).join('');

        document.getElementById('posSubtotal').innerText = subtotal.toFixed(2);
        document.getElementById('posTotal').innerText = subtotal.toFixed(2);
    },

    openPaymentModal: () => {
        if (POS.cart.length === 0) {
            showToast("Cart is empty! Add products first.");
            return;
        }

        const total = POS.cart.reduce((sum, item) => sum + (item.qty * item.price), 0);
        document.getElementById('payModalTotal').innerText = total.toFixed(2);
        document.getElementById('payAmountReceived').value = '';
        document.getElementById('payChange').innerText = '0.00';
        POS.setPaymentMethod('CASH');

        document.getElementById('paymentModal').classList.add('active');
    },

    closePaymentModal: () => {
        document.getElementById('paymentModal').classList.remove('active');
    },

    setPaymentMethod: (method) => {
        POS.selectedPaymentMethod = method;
        document.getElementById('btnPayCash').classList.toggle('active', method === 'CASH');
        document.getElementById('btnPayCard').classList.toggle('active', method === 'CARD');
        document.getElementById('cashFields').style.display = method === 'CASH' ? 'block' : 'none';
    },

    calculateChange: () => {
        const total = parseFloat(document.getElementById('payModalTotal').innerText);
        const received = parseFloat(document.getElementById('payAmountReceived').value || 0);
        const change = received - total;
        document.getElementById('payChange').innerText = change > 0 ? change.toFixed(2) : '0.00';
    },

    finalizeSale: () => {
        const total = parseFloat(document.getElementById('payModalTotal').innerText);
        let amountPaid = total;
        let change = 0;

        if (POS.selectedPaymentMethod === 'CASH') {
            amountPaid = parseFloat(document.getElementById('payAmountReceived').value || 0);
            if (amountPaid < total) {
                showToast("ERROR: Amount received is less than total price!");
                return;
            }
            change = amountPaid - total;
        }

        // Process record
        const txn = SalesLogic.recordSale(POS.cart, {
            method: POS.selectedPaymentMethod,
            total: total,
            amountPaid: amountPaid,
            change: change
        });

        showToast(`Sale Completed! TXN: ${txn.id}`);
        POS.closePaymentModal();
        POS.clearCart();
        POS.renderProducts();
    }
};

/* ==========================================================================
   5. OWNER / ADMIN USER INTERFACE MODULE
   ========================================================================== */
const Admin = {
    activeStockProductId: null,

    refresh: () => {
        Admin.renderDashboard();
        Admin.renderProducts();
        Admin.renderInventory();
        Admin.renderSales();
    },

    renderDashboard: () => {
        const sales = SalesLogic.getAll();
        const products = ProductLogic.getAll();

        const todayStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const todaySales = sales.filter(s => s.date === todayStr);

        const totalRev = todaySales.reduce((sum, s) => sum + s.total, 0);
        const lowStockCount = products.filter(p => p.stock <= p.minStock).length;

        document.getElementById('dashTodaySales').innerText = `₱${totalRev.toFixed(2)}`;
        document.getElementById('dashTxnCount').innerText = todaySales.length;
        document.getElementById('dashProductCount').innerText = products.length;
        document.getElementById('dashLowStockCount').innerText = lowStockCount;

        // Calculate Top Selling
        const salesMap = {};
        sales.forEach(s => {
            s.items.forEach(item => {
                if (!salesMap[item.id]) {
                    salesMap[item.id] = { name: item.name, qty: 0, revenue: 0 };
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
                    <td>-</td>
                    <td>${s.qty}</td>
                    <td>₱${s.revenue.toFixed(2)}</td>
                </tr>
            `).join('');
        }
    },

    renderProducts: () => {
        const products = ProductLogic.getAll();
        const tbody = document.getElementById('adminProductsTable');

        if (products.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--text-muted);">No products created yet</td></tr>`;
            return;
        }

        tbody.innerHTML = products.map(p => `
            <tr>
                <td><strong>${p.name}</strong></td>
                <td>${p.sku}</td>
                <td>${p.barcode}</td>
                <td>${p.category}</td>
                <td>₱${p.price.toFixed(2)}</td>
                <td>₱${p.cost.toFixed(2)}</td>
                <td>${p.stock}</td>
                <td><span class="badge ${p.status === 'Active' ? 'badge-success' : 'badge-danger'}">${p.status}</span></td>
                <td>
                    <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.8rem;" onclick="Admin.openEditProductModal('${p.id}')">Edit</button>
                    <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.8rem;" onclick="Admin.toggleProductStatus('${p.id}')">${p.status === 'Active' ? 'Deactivate' : 'Activate'}</button>
                    <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.8rem;" onclick="Admin.openAddStockModal('${p.id}')">+ Stock</button>
                </td>
            </tr>
        `).join('');
    },

    renderInventory: () => {
        const products = ProductLogic.getAll();
        const tbody = document.getElementById('adminInventoryTable');

        tbody.innerHTML = products.map(p => {
            let statusBadge = '<span class="badge badge-success">IN STOCK</span>';
            if (p.stock === 0) {
                statusBadge = '<span class="badge badge-danger">OUT OF STOCK</span>';
            } else if (p.stock <= p.minStock) {
                statusBadge = '<span class="badge badge-warning">LOW STOCK</span>';
            }

            return `
                <tr>
                    <td><strong>${p.name}</strong></td>
                    <td>${p.sku}</td>
                    <td>₱${p.price.toFixed(2)}</td>
                    <td><strong>${p.stock}</strong></td>
                    <td>${p.minStock}</td>
                    <td>${statusBadge}</td>
                    <td>
                        <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.8rem;" onclick="Admin.openAddStockModal('${p.id}')">+ Add Stock</button>
                    </td>
                </tr>
            `;
        }).join('');
    },

    renderSales: () => {
        const sales = SalesLogic.getAll();
        const tbody = document.getElementById('adminSalesTable');

        if (sales.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No transactions completed yet</td></tr>`;
            return;
        }

        tbody.innerHTML = sales.slice().reverse().map(s => `
            <tr>
                <td><strong>${s.id}</strong></td>
                <td>${s.date} ${s.time}</td>
                <td>${s.cashier}</td>
                <td><span class="badge badge-success">${s.paymentMethod}</span></td>
                <td>${s.items.map(i => `${i.name} (x${i.qty})`).join(', ')}</td>
                <td><strong>₱${s.total.toFixed(2)}</strong></td>
            </tr>
        `).join('');
    },

    openAddProductModal: () => {
        document.getElementById('productModalTitle').innerText = 'Add New Product';
        document.getElementById('productForm').reset();
        document.getElementById('pId').value = '';
        document.getElementById('productModal').classList.add('active');
    },

    openEditProductModal: (id) => {
        const p = ProductLogic.getById(id);
        if (!p) return;

        document.getElementById('productModalTitle').innerText = 'Edit Product';
        document.getElementById('pId').value = p.id;
        document.getElementById('pName').value = p.name;
        document.getElementById('pSku').value = p.sku;
        document.getElementById('pBarcode').value = p.barcode;
        document.getElementById('pCategory').value = p.category;
        document.getElementById('pStatus').value = p.status;
        document.getElementById('pPrice').value = p.price;
        document.getElementById('pCost').value = p.cost;
        document.getElementById('pStock').value = p.stock;
        document.getElementById('pMinStock').value = p.minStock;

        document.getElementById('productModal').classList.add('active');
    },

    closeProductModal: () => {
        document.getElementById('productModal').classList.remove('active');
    },

    saveProduct: (e) => {
        e.preventDefault();
        const productData = {
            id: document.getElementById('pId').value || null,
            name: document.getElementById('pName').value,
            sku: document.getElementById('pSku').value,
            barcode: document.getElementById('pBarcode').value,
            category: document.getElementById('pCategory').value,
            status: document.getElementById('pStatus').value,
            price: parseFloat(document.getElementById('pPrice').value),
            cost: parseFloat(document.getElementById('pCost').value || 0),
            stock: parseInt(document.getElementById('pStock').value),
            minStock: parseInt(document.getElementById('pMinStock').value || 5)
        };

        ProductLogic.saveProduct(productData);
        Admin.closeProductModal();
        Admin.refresh();
        POS.renderProducts();
        showToast("Product saved successfully!");
    },

    toggleProductStatus: (id) => {
        ProductLogic.toggleStatus(id);
        Admin.refresh();
        POS.renderProducts();
        showToast("Product status updated!");
    },

    openAddStockModal: (id) => {
        const p = ProductLogic.getById(id);
        if (!p) return;
        Admin.activeStockProductId = id;
        document.getElementById('stockModalProdName').innerText = `Add stock for: ${p.name} (Current Stock: ${p.stock})`;
        document.getElementById('stockAddQty').value = '';
        document.getElementById('stockModal').classList.add('active');
    },

    closeStockModal: () => {
        document.getElementById('stockModal').classList.remove('active');
    },

    submitAddStock: () => {
        const qty = parseInt(document.getElementById('stockAddQty').value || 0);
        if (qty <= 0) {
            showToast("Please enter a valid stock quantity!");
            return;
        }
        ProductLogic.addStock(Admin.activeStockProductId, qty);
        Admin.closeStockModal();
        Admin.refresh();
        POS.renderProducts();
        showToast("Stock added successfully!");
    }
};

/* ==========================================================================
   6. NAVIGATION & SYSTEM CONTROLLERS
   ========================================================================== */
function switchMainView(view) {
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

function switchAdminTab(tabName, btnElement) {
    document.querySelectorAll('.admin-menu-item').forEach(btn => btn.classList.remove('active'));
    btnElement.classList.add('active');

    document.querySelectorAll('.admin-tab-pane').forEach(pane => pane.classList.remove('active'));
    
    const targetPaneMap = {
        'dashboard': 'tabDashboard',
        'products': 'tabProducts',
        'inventory': 'tabInventory',
        'sales': 'tabSales'
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

// Initialize application on page load
window.addEventListener('DOMContentLoaded', () => {
    DB.initSeedData();
    POS.init();
    Admin.refresh();
});
