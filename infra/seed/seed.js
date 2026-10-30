// QuickBite benchmark seeder. Runs inside the core-service image (node + pg).
// SEED_PART=core|orders|all  SEED_SCALE=1 (1 = 1M customers / 5k restaurants / 50k orders per order DB)
// Every step commits together with a row in _seed_progress, so a re-run resumes where it stopped.
const {Client} = require('pg');
const SCALE = Number(process.env.SEED_SCALE || 1);
const PART = process.env.SEED_PART || 'all';
const PASSWORD = process.env.SEED_PASSWORD || 'Benchmark@123';
const D = '@seed.quickbite.test';
const N = {
  customers: Math.round(1_000_000 * SCALE), agents: Math.max(10, Math.round(5_000 * SCALE)),
  restaurants: Math.max(10, Math.round(5_000 * SCALE)), branches: 5, cats: 10, products: 120,
  staff: 3, media: 20, ordersPerDb: Math.round(50_000 * SCALE),
};
const log = (msg, extra = {}) => console.log(JSON.stringify({t: new Date().toISOString(), msg, ...extra}));
const cfg = (p) => ({host: process.env[p + '_HOST'], port: Number(process.env[p + '_PORT'] || 5432),
  user: process.env[p + '_USER'] || process.env[p + '_USERNAME'], password: process.env[p + '_PASSWORD'],
  database: process.env[p + '_NAME'], statement_timeout: 0, application_name: 'quickbite-seed'});

async function open(c) { const cl = new Client(c); await cl.connect(); return cl; }
async function progress(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS _seed_progress (step TEXT PRIMARY KEY, rows BIGINT, done_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}
async function step(db, name, sql, params = []) {
  const done = await db.query('SELECT 1 FROM _seed_progress WHERE step=$1', [name]);
  if (done.rowCount) return log('skip', {step: name});
  const t0 = Date.now();
  await db.query('BEGIN');
  try {
    const r = await db.query(sql, params);
    const rows = Array.isArray(r) ? r.reduce((a, x) => a + (x.rowCount || 0), 0) : (r.rows?.[0]?.n ?? r.rowCount);
    await db.query('INSERT INTO _seed_progress(step, rows) VALUES ($1,$2)', [name, rows]);
    await db.query('COMMIT');
    log('step', {step: name, rows: Number(rows), ms: Date.now() - t0});
  } catch (e) { await db.query('ROLLBACK'); throw e; }
}
const ranges = (n, size) => { const out = []; for (let a = 1; a <= n; a += size) out.push([a, Math.min(n, a + size - 1)]); return out; };

// ------------------------------------------------------------------ core
async function seedCore() {
  const db = await open(cfg('DB'));
  await progress(db);
  await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  const {rows: [{h}]} = await db.query(`SELECT crypt($1, gen_salt('bf', 10)) AS h`, [PASSWORD]);
  const ts = `now() - (random() * 700) * interval '1 day'`;

  for (const [a, b] of ranges(N.customers, 100_000))
    await step(db, `users:customers:${a}`, `
      INSERT INTO users (email, phone, password_hash, system_role, name, created_at, updated_at)
      SELECT 'customer'||g||'${D}', '+201'||lpad(g::text, 9, '0'), $3, 'customer', 'Customer '||g, t, t
      FROM generate_series($1::int, $2::int) g, LATERAL (SELECT ${ts} + g * interval '0 s') x(t)`, [a, b, h]);
  await step(db, 'users:agents', `
    INSERT INTO users (email, phone, password_hash, system_role, name, created_at, updated_at)
    SELECT 'agent'||g||'${D}', '+202'||lpad(g::text, 9, '0'), $2, 'delivery_agent', 'Agent '||g, now(), now()
    FROM generate_series(1, $1::int) g`, [N.agents, h]);
  await step(db, 'users:restaurant', `
    INSERT INTO users (email, phone, password_hash, system_role, name, created_at, updated_at)
    SELECT e, p, $3, 'restaurant_user', nm, now(), now() FROM (
      SELECT 'owner'||g||'${D}' e, '+203'||lpad(g::text, 9, '0') p, 'Owner '||g nm FROM generate_series(1, $1::int) g
      UNION ALL
      SELECT 'staff'||g||'_'||k||'${D}', '+204'||lpad((g * 10 + k)::text, 9, '0'), 'Staff '||g||'-'||k
      FROM generate_series(1, $1::int) g, generate_series(1, $2::int) k) s`, [N.restaurants, N.staff, h]);

  // customer g lives in EG when g % 5 < 3, otherwise SA (60/40)
  const geo = (c) => `CASE WHEN ${c} % 5 < 3 THEN 'EG' ELSE 'SA' END`;
  const city = (c) => `CASE WHEN ${c} % 5 < 3 THEN (ARRAY['Cairo','Giza','Alexandria'])[1 + ${c} % 3] ELSE (ARRAY['Riyadh','Jeddah'])[1 + ${c} % 2] END`;
  const lat = (c) => `CASE WHEN ${c} % 5 < 3 THEN (ARRAY[30.0444,30.0131,31.2001])[1 + ${c} % 3] ELSE (ARRAY[24.7136,21.4858])[1 + ${c} % 2] END + (random() - 0.5) * 0.1`;
  const lng = (c) => `CASE WHEN ${c} % 5 < 3 THEN (ARRAY[31.2357,31.2089,29.9187])[1 + ${c} % 3] ELSE (ARRAY[46.6753,39.1925])[1 + ${c} % 2] END + (random() - 0.5) * 0.1`;
  for (const [a, b] of ranges(N.customers, 100_000))
    await step(db, `addresses:${a}`, `
      INSERT INTO customer_addresses (user_id, label, text, lat, lng, created_at, is_default, country, city, street, building, apartment_number, type)
      SELECT u.id, l.label, (10 + g % 90)||' Street '||(g % 500)||', '||${city('g')}, ${lat('g')}, ${lng('g')}, now(), l.k = 1,
             ${geo('g')}, ${city('g')}, 'Street '||(g % 500), (1 + g % 60)::text, (1 + g % 20)::text, l.type
      FROM generate_series($1::int, $2::int) g
      JOIN users u ON u.email = 'customer'||g||'${D}'
      CROSS JOIN LATERAL (SELECT * FROM (VALUES (1, 'Home', 'home'), (2, 'Work', 'office')) v(k, label, type)
                          WHERE v.k = 1 OR g % 2 = 0) l`, [a, b]);

  await step(db, 'restaurants', `
    INSERT INTO restaurants (owner_id, name, logo_url, status, primary_country, create_at, updated_at, status_updated_at)
    SELECT u.id, 'Seed Restaurant '||g, 'https://dodsquickbites3.s3.eu-north-1.amazonaws.com/seed/logo/'||g||'.png',
           CASE WHEN g % 20 = 0 THEN 'pending' ELSE 'active' END, ${geo('g')}, now(), now(), now()
    FROM generate_series(1, $1::int) g JOIN users u ON u.email = 'owner'||g||'${D}'`, [N.restaurants]);
  const rest = `(SELECT id, substring(name from 17)::int AS g, primary_country FROM restaurants WHERE name LIKE 'Seed Restaurant %')`;
  await step(db, 'branches', `
    INSERT INTO restaurant_branches (restaurant_id, country_code, address_text, label, lat, lng, is_active, opens_at, closes_at,
                                     accept_orders, created_at, updated_at, delivery_radius, currency, commission, delivery_fee_minor)
    SELECT r.id, r.primary_country, k||' Main Road, '||${city('r.g')}, 'Branch '||k,
           ${lat('r.g')}, ${lng('r.g')}, true, '00:00', '23:59:59', true, now(), now(), 10,
           CASE WHEN r.primary_country = 'EG' THEN 'EGP' ELSE 'SAR' END, 15,
           CASE WHEN r.primary_country = 'EG' THEN 1500 ELSE 1000 END
    FROM ${rest} r CROSS JOIN generate_series(1, $1::int) k`, [N.branches]);
  await step(db, 'categories', `
    INSERT INTO product_categories (restaurant_id, name, created_at, updated_at)
    SELECT r.id, 'Category '||k, now(), now() FROM ${rest} r CROSS JOIN generate_series(1, $1::int) k`, [N.cats]);

  // products: the AFTER INSERT trigger would add price-0 rows per branch that we would then rewrite;
  // insert product_branch_details directly instead and switch the trigger back on afterwards.
  await db.query('ALTER TABLE products DISABLE TRIGGER trg_product_after_insert');
  try {
    for (const [a, b] of ranges(N.restaurants, 500)) {
      await step(db, `products:${a}`, `
        INSERT INTO products (name, description, image_url, restaurant_id, category_id, created_at, updated_at)
        SELECT 'Dish '||r.g||'-'||k, 'Freshly prepared dish number '||k||' from restaurant '||r.g||'. Made to order with seasonal ingredients and served hot.',
               'https://dodsquickbites3.s3.eu-north-1.amazonaws.com/seed/product/'||r.g||'/'||k||'.jpg', r.id, c.id, now(), now()
        FROM ${rest} r CROSS JOIN generate_series(1, $3::int) k
        JOIN product_categories c ON c.restaurant_id = r.id AND c.name = 'Category '||(1 + k % $4::int)
        WHERE r.g BETWEEN $1 AND $2`, [a, b, N.products, N.cats]);
      await step(db, `pbd:${a}`, `
        INSERT INTO product_branch_details (branch_id, product_id, price, stock, is_available)
        SELECT br.id, p.id, 2000 + (p.id * 37 % 30000), 1000, true
        FROM ${rest} r JOIN products p ON p.restaurant_id = r.id JOIN restaurant_branches br ON br.restaurant_id = r.id
        WHERE r.g BETWEEN $1 AND $2`, [a, b]);
    }
  } finally {
    await db.query('ALTER TABLE products ENABLE TRIGGER trg_product_after_insert');
  }

  await step(db, 'members', `
    INSERT INTO restaurant_members (restaurant_id, user_id, role_id, status, created_at, updated_at)
    SELECT r.id, u.id, ro.id, 'active', now(), now() FROM ${rest} r
    CROSS JOIN LATERAL (VALUES (0, 'owner'||r.g||'${D}', 'owner'), (1, 'staff'||r.g||'_1${D}', 'branch_manager'),
                               (2, 'staff'||r.g||'_2${D}', 'staff'), (3, 'staff'||r.g||'_3${D}', 'staff')) v(k, email, role)
    JOIN users u ON u.email = v.email JOIN roles ro ON ro.name = v.role
    WHERE v.k <= $1`, [N.staff]);
  await step(db, 'member_branches', `
    INSERT INTO member_branches (member_id, branch_id, created_at)
    SELECT m.id, br.id, now() FROM restaurant_members m
    JOIN users u ON u.id = m.user_id AND u.email LIKE 'staff%${D}'
    JOIN restaurant_branches br ON br.restaurant_id = m.restaurant_id
         AND br.label = 'Branch '||split_part(split_part(u.email, '_', 2), '@', 1)`);
  await step(db, 'media', `
    INSERT INTO media (restaurant_id, uploaded_by, status, media_path, content_type, size_bytes, created_at)
    SELECT r.id, re.owner_id, 'ready', 'seed/restaurant/'||r.id||'/'||k||'.jpg', 'image/jpeg', 50000 + (random() * 400000)::int, now()
    FROM ${rest} r JOIN restaurants re ON re.id = r.id CROSS JOIN generate_series(1, $1::int) k`, [N.media]);
  const {rows: [mm]} = await db.query(`SELECT min(id) lo, max(id) hi FROM products`);
  for (let a = Number(mm.lo); a <= Number(mm.hi); a += 100_000)
    await step(db, `outbox:products:${a}`, `
      INSERT INTO event_outbox (channel, event_type, entity_type, entity_id, payload, status, attempts, created_at, published_at)
      SELECT 'core.events', 'core.product.invalidated', 'product', p.id,
             jsonb_build_object('productId', p.id, 'restaurantId', p.restaurant_id, 'reason', 'created', 'name', p.name),
             'published', 1, p.created_at, p.created_at + interval '2 s'
      FROM products p WHERE p.id BETWEEN $1 AND $1 + 99999`, [a]);
  await step(db, 'outbox:branches', `
    INSERT INTO event_outbox (channel, event_type, entity_type, entity_id, payload, status, attempts, created_at, published_at)
    SELECT 'core.events', 'core.branch.invalidated', 'branch', b.id,
           jsonb_build_object('branchId', b.id, 'restaurantId', b.restaurant_id, 'reason', 'created'), 'published', 1, now(), now()
    FROM restaurant_branches b`);
  await step(db, 'analyze', `ANALYZE`);
  const s = await db.query(`SELECT pg_size_pretty(pg_database_size(current_database())) size,
    (SELECT count(*) FROM users) users, (SELECT count(*) FROM customer_addresses) addresses, (SELECT count(*) FROM restaurants) restaurants,
    (SELECT count(*) FROM restaurant_branches) branches, (SELECT count(*) FROM products) products,
    (SELECT count(*) FROM product_branch_details) pbd, (SELECT count(*) FROM event_outbox) outbox`);
  log('core done', s.rows[0]);
  await db.end();
}

// ------------------------------------------------------------------ orders
async function loadRefs(core, cc) {
  const br = await core.query(`
    SELECT b.id, b.restaurant_id, b.label, r.name rname, b.address_text, b.delivery_fee_minor fee, b.commission,
           (SELECT count(*) FROM (SELECT 1 FROM products p WHERE p.restaurant_id = b.restaurant_id LIMIT 30) x) pcnt
    FROM restaurant_branches b JOIN restaurants r ON r.id = b.restaurant_id
    WHERE r.name LIKE 'Seed Restaurant %' AND r.status = 'active' AND b.country_code = $1`, [cc]);
  const pr = await core.query(`
    SELECT restaurant_id, k, id, name, image_url, 2000 + (id * 37 % 30000) price FROM (
      SELECT p.*, row_number() OVER (PARTITION BY p.restaurant_id ORDER BY p.id) k
      FROM products p JOIN restaurants r ON r.id = p.restaurant_id
      WHERE r.name LIKE 'Seed Restaurant %' AND r.primary_country = $1) x WHERE k <= 30`, [cc]);
  const cu = await core.query(`
    SELECT u.id, a.id aid, a.lat, a.lng, a.text FROM users u
    JOIN customer_addresses a ON a.user_id = u.id AND a.is_default
    WHERE u.email LIKE 'customer%${D}' AND a.country = $1 ORDER BY random() LIMIT $2`, [cc, Math.max(1000, N.ordersPerDb * 3)]);
  const ag = await core.query(`SELECT id FROM users WHERE email LIKE 'agent%${D}'`);
  log('refs', {country: cc, branches: br.rowCount, products: pr.rowCount, customers: cu.rowCount, agents: ag.rowCount});
  return {br: br.rows, pr: pr.rows, cu: cu.rows, ag: ag.rows};
}

async function loadTemp(db, refs) {
  await db.query(`
    CREATE TEMP TABLE sb (idx serial, branch_id bigint, restaurant_id bigint, label text, rname text, addr text, fee int, comm int, pcnt int);
    CREATE TEMP TABLE sp (restaurant_id bigint, k int, product_id bigint, name text, image_url text, price int, PRIMARY KEY (restaurant_id, k));
    CREATE TEMP TABLE sc (idx serial PRIMARY KEY, customer_id bigint, address_id bigint, lat numeric, lng numeric, addr text);
    CREATE TEMP TABLE sa (idx serial PRIMARY KEY, agent_id bigint);
    CREATE OR REPLACE FUNCTION pg_temp.uuid7(ts timestamptz) RETURNS uuid AS $$
      SELECT encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) PLACING
        substring(int8send(floor(extract(epoch FROM ts) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid
    $$ LANGUAGE sql VOLATILE;`);
  const chunk = async (rows, sql, cols) => {
    for (let i = 0; i < rows.length; i += 20000) {
      const part = rows.slice(i, i + 20000);
      await db.query(sql, cols.map((c) => part.map((r) => r[c])));
    }
  };
  await chunk(refs.br.filter((b) => Number(b.pcnt) > 0), `INSERT INTO sb (branch_id, restaurant_id, label, rname, addr, fee, comm, pcnt)
    SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::int[])`,
    ['id', 'restaurant_id', 'label', 'rname', 'address_text', 'fee', 'commission', 'pcnt']);
  await chunk(refs.pr, `INSERT INTO sp SELECT * FROM unnest($1::bigint[], $2::int[], $3::bigint[], $4::text[], $5::text[], $6::int[])`,
    ['restaurant_id', 'k', 'id', 'name', 'image_url', 'price']);
  await chunk(refs.cu, `INSERT INTO sc (customer_id, address_id, lat, lng, addr) SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::numeric[], $4::numeric[], $5::text[])`,
    ['id', 'aid', 'lat', 'lng', 'text']);
  await chunk(refs.ag, `INSERT INTO sa (agent_id) SELECT * FROM unnest($1::bigint[])`, ['id']);
  await db.query('ANALYZE sb; ANALYZE sp; ANALYZE sc; ANALYZE sa;');
  const {rows: [c]} = await db.query('SELECT (SELECT count(*) FROM sb) nb, (SELECT count(*) FROM sc) nc, (SELECT count(*) FROM sa) na');
  return {nb: Number(c.nb), nc: Number(c.nc), na: Number(c.na)};
}

function ordersSql(region, archive) {
  const cc = region === 'eg' ? 'EG' : 'SA', cur = region === 'eg' ? 'EGP' : 'SAR';
  const online = region === 'eg' ? 0.7 : 0;  // only the eg shards have a payment provider (kashier)
  const tsExpr = archive
    ? `timestamp '2025-01-01' + random() * (timestamp '2025-12-31 23:00' - timestamp '2025-01-01')`
    : `CASE WHEN rs >= 0.93 THEN now()::timestamp - random() * interval '90 minutes'
            ELSE timestamp '2026-01-01' + random() * (now()::timestamp - interval '3 hours' - timestamp '2026-01-01') END`;
  const statusExpr = archive
    ? `CASE WHEN rs < 0.90 THEN 'delivered' WHEN rs < 0.97 THEN 'cancelled' ELSE 'rejected' END`
    : `CASE WHEN rs < 0.85 THEN 'delivered' WHEN rs < 0.90 THEN 'cancelled' WHEN rs < 0.93 THEN 'rejected'
            ELSE (ARRAY['placed','accepted','preparing','ready','assigned','picked'])[1 + (g % 6)] END`;
  const at = (s, mins, list) => `CASE WHEN status IN (${list}) THEN ts + interval '${mins} minutes' END`;
  const after = (s) => {
    const order = ['placed', 'accepted', 'preparing', 'ready', 'assigned', 'picked', 'delivered'];
    return order.slice(order.indexOf(s)).map((x) => `'${x}'`).join(',');
  };
  return `
  WITH r AS (
    SELECT g, 1 + floor(random() * $3)::int bi, 1 + floor(random() * $4)::int ci, 1 + floor(random() * $5)::int ai,
           rs, random() rp, 1 + floor(random() * 5)::int ni, (${tsExpr}) ts
    FROM generate_series($1::int, $2::int) g, LATERAL (SELECT random() + g * 0 AS rs) z
  ), o AS MATERIALIZED (
    SELECT r.*, b.branch_id, b.restaurant_id, b.label bname, b.rname, b.fee, b.comm, b.pcnt,
           c.customer_id, c.address_id, c.lat, c.lng, c.addr, a.agent_id,
           ${statusExpr} AS status, CASE WHEN rp < ${online} THEN 'online' ELSE 'cod' END AS pm, pg_temp.uuid7(r.ts) pid
    FROM r JOIN sb b ON b.idx = r.bi JOIN sc c ON c.idx = r.ci JOIN sa a ON a.idx = r.ai
  ), it AS MATERIALIZED (
    SELECT o.g, o.pid, o.ts, p.product_id, p.name, p.image_url, p.price, (1 + floor(random() * 3))::int qty
    FROM o CROSS JOIN LATERAL generate_series(1, o.ni) AS ln(n)
    JOIN sp p ON p.restaurant_id = o.restaurant_id AND p.k = 1 + ((o.g * 7 + ln.n * 13) % o.pcnt)
  ), s AS (SELECT g, sum(qty * price)::int subtotal FROM it GROUP BY g),
  ins AS (
    INSERT INTO orders (region, public_id, country_code, restaurant_id, branch_id, customer_id, customer_address_id, delivery_lat, delivery_lng,
      delivery_address_text_snapshot, branch_name_snapshot, restaurant_name_snapshot, status, status_reason, subtotal, delivery_fee, service_fee,
      total, commission, currency, payment_method, delivery_agent_id, created_at, updated_at, placed_at, accepted_at, rejected_at, preparing_at,
      ready_at, assigned_at, picked_at, delivered_at, cancelled_at)
    SELECT '${region}', pid, '${cc}', restaurant_id, branch_id, customer_id, address_id, lat, lng, coalesce(addr, 'Seed address'), bname, rname, status,
      CASE status WHEN 'cancelled' THEN 'customer_cancelled' WHEN 'rejected' THEN 'restaurant_busy' END,
      s.subtotal, fee, 500, s.subtotal + fee + 500, (s.subtotal * comm / 100), '${cur}', pm,
      CASE WHEN status IN ('assigned','picked','delivered') THEN agent_id END, ts, ts + interval '45 minutes',
      ts + interval '1 minute', ${at('', 3, after('accepted'))}, CASE WHEN status = 'rejected' THEN ts + interval '3 minutes' END,
      ${at('', 5, after('preparing'))}, ${at('', 20, after('ready'))}, ${at('', 22, after('assigned'))}, ${at('', 30, after('picked'))},
      ${at('', 45, "'delivered'")}, CASE WHEN status = 'cancelled' THEN ts + interval '2 minutes' END
    FROM o JOIN s USING (g)
    RETURNING id, public_id, created_at, status, payment_method, total, commission, restaurant_id, delivery_agent_id, delivered_at, currency
  ), ii AS (
    INSERT INTO order_items (region, order_id, product_id, quantity, unit_price_snapshot, name_snapshot, image_url_snapshot, line_total, created_at)
    SELECT '${region}', ins.id, it.product_id, it.qty, it.price, it.name, it.image_url, it.qty * it.price, it.ts
    FROM it JOIN ins ON ins.public_id = it.pid RETURNING 1
  ), ps AS (
    INSERT INTO payment_sessions (region, order_id, order_public_id, provider_id, merchant_order_ref, provider_session_id, provider_order_id,
      redirect_url, amount, currency, status, expires_at, raw_init_payload, raw_last_payload, created_at, updated_at)
    SELECT '${region}', id, public_id, 1, 'QB-'||public_id, 'ks_'||md5(public_id::text), 'ko_'||substr(md5(public_id::text || 'o'), 1, 20),
      'https://checkout.kashier.io/?sessionId=ks_'||md5(public_id::text), total, currency,
      CASE WHEN status IN ('cancelled','rejected') THEN 'failed' ELSE 'captured' END, created_at + interval '15 minutes',
      jsonb_build_object('merchantId', 'MID-SEED', 'orderId', 'QB-'||public_id, 'amount', total, 'currency', currency, 'display', 'en',
                         'redirect', 'https://app.quickbite.io/checkout/return', 'serverWebhook', true, 'allowedMethods', 'card,wallet'),
      jsonb_build_object('status', CASE WHEN status IN ('cancelled','rejected') THEN 'FAILURE' ELSE 'SUCCESS' END, 'transactionId', md5(public_id::text),
                         'cardBrand', 'Visa', 'maskedCard', '411111******1111', 'amount', total, 'currency', currency),
      created_at, created_at + interval '2 minutes'
    FROM ins WHERE payment_method = 'online' RETURNING 1
  ), tx AS (
    INSERT INTO transactions (region, order_id, order_public_id, transaction_type, method, provider_id, provider_reference_id, status, amount,
      currency, idempotency_key, created_at, updated_at, restaurant_id)
    SELECT '${region}', id, public_id, t.type, t.method, t.prov, t.ref, 'succeeded', t.amount, currency, t.type||':'||public_id,
      coalesce(delivered_at, created_at), coalesce(delivered_at, created_at), restaurant_id
    FROM ins CROSS JOIN LATERAL (VALUES
      (CASE WHEN payment_method = 'online' THEN 'charge' ELSE 'cod_collection' END, payment_method,
       CASE WHEN payment_method = 'online' THEN 1 END, CASE WHEN payment_method = 'online' THEN 'kt_'||md5(public_id::text) END, total),
      ('commission', 'system', NULL::int, NULL::text, commission)) t(type, method, prov, ref, amount)
    WHERE status = 'delivered' AND t.amount > 0 RETURNING 1
  ), ae AS (
    INSERT INTO agent_earnings (region, agent_id, order_id, order_public_id, amount, currency, distance_meters, earned_at)
    SELECT '${region}', delivery_agent_id, id, public_id, 1500 + d * 300 / 1000, currency, d, delivered_at
    FROM ins, LATERAL (SELECT 500 + (random() * 7500)::int + id * 0 d) dd
    WHERE status = 'delivered' AND delivery_agent_id IS NOT NULL RETURNING 1
  ), ev AS (
    INSERT INTO events_outbox (event_id, event_type, entity_type, entity_id, payload, status, attempts, created_at, published_at)
    SELECT gen_random_uuid(), e.type, 'order', public_id::text,
      jsonb_build_object('orderId', public_id, 'restaurantId', restaurant_id, 'status', status, 'total', total, 'currency', currency, 'region', '${region}'),
      'published', 1, e.at, e.at + interval '2 seconds'
    FROM ins CROSS JOIN LATERAL (VALUES ('order.placed', created_at),
      (CASE WHEN status IN ('delivered','cancelled','rejected') THEN 'order.'||status END, coalesce(delivered_at, created_at + interval '3 minutes'))) e(type, at)
    WHERE e.type IS NOT NULL RETURNING 1
  ), wh AS (
    INSERT INTO payment_webhook_events (region, provider_id, provider_event_id, event_type, signature, payload, received_at, processed_at)
    SELECT '${region}', 1, 'evt_'||md5(public_id::text), CASE WHEN status IN ('cancelled','rejected') THEN 'pay.failed' ELSE 'pay.success' END,
      md5(public_id::text || 's1') || md5(public_id::text || 's2'),
      jsonb_build_object('event', 'pay', 'data', jsonb_build_object('merchantOrderId', 'QB-'||public_id, 'transactionId', md5(public_id::text),
        'status', CASE WHEN status IN ('cancelled','rejected') THEN 'FAILURE' ELSE 'SUCCESS' END, 'amount', total, 'currency', currency,
        'method', 'card', 'cardInfo', jsonb_build_object('brand', 'Visa', 'masked', '411111******1111'))),
      created_at + interval '2 minutes', created_at + interval '2 minutes 1 second'
    FROM ins WHERE payment_method = 'online' RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins) n, (SELECT count(*) FROM ii) items, (SELECT count(*) FROM ps) sessions, (SELECT count(*) FROM tx) txs,
         (SELECT count(*) FROM ae) earnings, (SELECT count(*) FROM ev) events, (SELECT count(*) FROM wh) webhooks`;
}

async function seedOrders() {
  const core = await open(cfg('DB'));
  for (const region of ['eg', 'sa']) {
    const refs = await loadRefs(core, region.toUpperCase());
    for (const archive of [true, false]) {
      const prefix = (archive ? 'ARCHIVE_DB_' : 'DB_') + region;
      const db = await open(cfg(prefix));
      await progress(db);
      if (!archive) // keep hot ids above anything the archive shard holds, so a later archival move never collides
        await step(db, 'sequences', `SELECT count(setval(s::regclass, greatest(10000000, coalesce((SELECT last_value FROM pg_sequences WHERE sequencename = s), 0)))) n
          FROM unnest(ARRAY['orders_id_seq','order_items_id_seq','payment_sessions_id_seq','transactions_id_seq','agent_earnings_id_seq','events_outbox_id_seq','payment_webhook_events_id_seq']) s`);
      const n = await loadTemp(db, refs);
      log('temp loaded', {db: prefix, ...n});
      const sql = ordersSql(region, archive);
      for (const [a, b] of ranges(N.ordersPerDb, 10_000))
        await step(db, `orders:${a}`, sql, [a, b, n.nb, n.nc, n.na]);
      if (!archive)
        await step(db, 'balances', `
          INSERT INTO restaurant_balances (restaurant_id, region, currency, balance, updated_at)
          SELECT restaurant_id, '${region}', currency, sum(subtotal - commission)::int, now() FROM orders WHERE status = 'delivered'
          GROUP BY restaurant_id, currency
          ON CONFLICT (restaurant_id, currency) DO UPDATE SET balance = EXCLUDED.balance, updated_at = now()`);
      await step(db, 'analyze', 'ANALYZE');
      const s = await db.query(`SELECT pg_size_pretty(pg_database_size(current_database())) size, (SELECT count(*) FROM orders) orders,
        (SELECT count(*) FROM order_items) items, (SELECT count(*) FROM transactions) txs, (SELECT count(*) FROM events_outbox) events`);
      log('order db done', {db: prefix, ...s.rows[0]});
      await db.end();
    }
  }
  await core.end();
}

(async () => {
  log('seed start', {part: PART, scale: SCALE, counts: N});
  if (PART === 'core' || PART === 'all') await seedCore();
  if (PART === 'orders' || PART === 'all') await seedOrders();
  log('seed finished');
})().catch((e) => { log('seed failed', {error: e.message, detail: e.detail, where: e.where}); process.exit(1); });
