/**
 * Order repository. Creation happens through `db.batch()` — one atomic D1
 * transaction for (order row + audit event), so orders and their audit trail
 * can never diverge.
 */
export interface OrderRow {
  id: string;
  customer_id: number;
  state: string;
  selections: string;
  amount: number;
  currency: string;
  idempotency_key: string | null;
  created_at: string;
}

export interface NewOrderFields {
  id: string;
  customerId: number;
  selections: string; // JSON snapshot, built by checkout
  amount: number;
  currency: string;
  idempotencyKey: string;
}

export async function insertOrderWithEvent(
  db: D1Database,
  order: NewOrderFields,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO orders (id, customer_id, state, selections, amount, currency, idempotency_key)
         VALUES (?1, ?2, 'pending_payment', ?3, ?4, ?5, ?6)`,
      )
      .bind(
        order.id,
        order.customerId,
        order.selections,
        order.amount,
        order.currency,
        order.idempotencyKey,
      ),
    db
      .prepare(
        `INSERT INTO order_events (order_id, actor, action, to_state, data)
         VALUES (?1, 'customer', 'order_created', 'pending_payment', ?2)`,
      )
      .bind(order.id, JSON.stringify({ idempotency_key: order.idempotencyKey })),
  ]);
}

export async function findOrderByIdempotencyKey(
  db: D1Database,
  key: string,
): Promise<OrderRow | null> {
  return db
    .prepare('SELECT * FROM orders WHERE idempotency_key = ?1')
    .bind(key)
    .first<OrderRow>();
}
