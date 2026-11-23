-- Docker 1.4.3 / schema 22 table layout, retained for upgrade regression tests.
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, price TEXT NOT NULL,
    compare_at_price TEXT, max_points_discount TEXT, category TEXT, image TEXT, is_hot INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1, is_shared INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0,
    purchase_limit INTEGER, purchase_warning TEXT, visibility_level INTEGER DEFAULT -1,
    stock_count INTEGER DEFAULT 0, locked_count INTEGER DEFAULT 0, sold_count INTEGER DEFAULT 0,
    rating INTEGER DEFAULT 0, review_count INTEGER DEFAULT 0, created_at INTEGER,
    variant_group_id TEXT, variant_label TEXT, purchase_questions TEXT, product_images TEXT
);
CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL, card_key TEXT NOT NULL,
    is_used INTEGER DEFAULT 0, reserved_order_id TEXT, reserved_at INTEGER,
    expires_at INTEGER, used_at INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY, product_id TEXT NOT NULL, product_name TEXT NOT NULL,
    amount TEXT NOT NULL, email TEXT, payee TEXT, status TEXT DEFAULT 'pending',
    trade_no TEXT, card_key TEXT, card_ids TEXT, paid_at INTEGER, delivered_at INTEGER,
    user_id TEXT, username TEXT, points_used INTEGER DEFAULT 0, quantity INTEGER DEFAULT 1,
    current_payment_id TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS login_users (
    user_id TEXT PRIMARY KEY, username TEXT, email TEXT, points INTEGER DEFAULT 0,
    is_blocked INTEGER DEFAULT 0, desktop_notifications_enabled INTEGER DEFAULT 0,
    created_at INTEGER, last_login_at INTEGER, last_checkin_at INTEGER,
    consecutive_days INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS daily_checkins_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, icon TEXT,
    sort_order INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL, order_id TEXT NOT NULL,
    user_id TEXT NOT NULL, username TEXT NOT NULL, rating INTEGER NOT NULL,
    comment TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS review_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, username TEXT NOT NULL, comment TEXT NOT NULL, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS inventory_imports (
    idempotency_key TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    payload_hash TEXT NOT NULL, imported_count INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS refund_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, user_id TEXT,
    username TEXT, reason TEXT, status TEXT DEFAULT 'pending', admin_username TEXT,
    admin_note TEXT, created_at INTEGER, updated_at INTEGER, processed_at INTEGER
);
CREATE TABLE IF NOT EXISTS user_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, type TEXT NOT NULL,
    title_key TEXT NOT NULL, content_key TEXT NOT NULL, data TEXT,
    is_read INTEGER DEFAULT 0, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS admin_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT NOT NULL, target_value TEXT,
    title TEXT NOT NULL, body TEXT NOT NULL, sender TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS user_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT,
    title TEXT NOT NULL, body TEXT NOT NULL, is_read INTEGER DEFAULT 0, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS broadcast_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL,
    sender TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS broadcast_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL,
    user_id TEXT NOT NULL, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS wishlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
    user_id TEXT, username TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS wishlist_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    user_id TEXT NOT NULL, created_at INTEGER
);
