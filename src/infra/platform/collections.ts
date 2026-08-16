/**
 * Physical MongoDB collection names in the shared `jovi_mall` database.
 *
 * ── COPIED VERBATIM from jovi-mall ────────────────────────────────────────────
 *   source: jovi-mall/src/core/database/collections.ts  (the COLLECTIONS export)
 *
 * This is the ONE artifact worth duplicating across the two services, and the reason is
 * narrow: it is pure frozen constants with zero imports, so copying it carries no
 * behaviour and no dependency graph — unlike a Mongoose model, which registers itself on
 * the importing process's default connection and drags module config along with it
 * (jovi-mall's `agent.config.ts` throws at load unless its trust weights sum to 100).
 *
 * The alternative is guessing pluralisation, and `delivery_agencies`,
 * `cod_discrepancies`, `file_cleanup_audit` and `agency_magazins` are each a guess away
 * from a query that returns nothing and looks like missing data.
 *
 * jovi-mall passes these as `model()`'s third argument in 84 places, so what is written
 * here is exactly what is on disk.
 *
 * ── Keeping it in step ────────────────────────────────────────────────────────
 * `scripts/test/test-data-access.ts` re-reads jovi-mall's file and asserts every key this
 * service uses still maps to the same string. A rename there fails the suite here rather
 * than silently emptying a screen.
 *
 * Note what is NOT copied: the `MODELS` map. This service registers no Mongoose models on
 * the platform connection and issues no `populate()`, so model-registration names have no
 * meaning here — see ADR-004 D-3.
 */

export const COLLECTIONS = Object.freeze({
  // Users & roles
  USER: 'users',
  ADMIN: 'admins',
  CUSTOMER: 'customers',
  VENDOR: 'vendors',

  // Store
  STORE: 'stores',

  // Magazin (delivery agency's business surface — the Store-equivalent for agencies)
  AGENCY_MAGAZIN: 'agency_magazins',

  // Catalog
  PRODUCT: 'products',
  PRODUCT_VARIANT: 'product_variants',
  PRODUCT_OPTION: 'product_options',
  PRODUCT_OPTION_VALUE: 'product_option_values',
  SHIPPING_CONFIG: 'shipping_configs',
  SERVICE_CONFIG: 'service_configs',
  SERVICE_AVAILABILITY: 'service_availabilities',
  STOCK_RESERVATION: 'stock_reservations',
  STOCK_AUDIT_LOG: 'stock_audit_logs',
  AGENCY_STOCK_LEVEL: 'agency_stock_levels',
  STOCK_ADJUSTMENT_REQUEST: 'stock_adjustment_requests',
  FILE: 'files',
  FILE_REFERENCE: 'file_references',
  FILE_CLEANUP_AUDIT: 'file_cleanup_audit',
  CATALOG_DIGITAL_ASSET: 'catalog_digital_assets',

  // Cart
  CART: 'carts',

  // Orders
  ORDER: 'orders',
  ORDER_TIMELINE: 'order_timelines',
  VENDOR_ORDER_NOTE: 'vendor_order_notes',

  // Shipments & delivery
  SHIPMENT: 'shipments',
  SHIPMENT_ASSIGNMENT_OFFER: 'shipment_assignment_offers',
  SHIPMENT_ASSIGNMENT_SESSION: 'shipment_assignment_sessions',
  DELIVERY_AGENCY: 'delivery_agencies',
  DELIVERY_AGENT: 'delivery_agents',

  // Agent domain (agent ↔ agency contracts; an agent may serve many agencies,
  // each contract sub-allocating a slice of the agent's global COD threshold)
  AGENT_AGENCY_CONTRACT: 'agent_agency_contracts',
  AGENT_MEMBERSHIP_EVENT: 'agent_membership_events',
  CONTRACT_STATUS_REQUEST: 'contract_status_requests',
  CONTRACT_TERMS_PROPOSAL: 'contract_terms_proposals',

  // Vendor <-> agency connections
  VENDOR_AGENCY_CONNECTION: 'vendor_agency_connections',

  // Live-tracking integration (outbox → geo-tracker service)
  TRACKING_OUTBOX: 'tracking_outbox',

  // Payments
  PAYMENT_TRANSACTION: 'payment_transactions',
  REFUND_TRANSACTION: 'refund_transactions',
  USER_PAYMENT_METHOD: 'user_payment_methods',

  // Booking
  BOOKING: 'bookings',
  AVAILABILITY_RULE: 'availability_rules',
  EXTERNAL_CALENDAR_BLOCK: 'external_calendar_blocks',

  // Digital delivery
  DIGITAL_ASSET: 'digital_assets',
  CUSTOMER_DIGITAL_ENTITLEMENT: 'customer_digital_entitlements',

  // Tickets
  TICKET: 'tickets',
  TICKET_NOTE: 'ticket_notes',
  TICKET_FOLLOWER: 'ticket_followers',
  TICKET_ATTACHMENT: 'ticket_attachments',

  // Vendor analytics & settings
  VENDOR_SETTINGS: 'vendor_settings',
  VENDOR_CUSTOMER: 'vendor_customers',
  VENDOR_DAILY_METRICS: 'vendor_daily_metrics',
  VENDOR_VARIANT_DAILY_METRICS: 'vendor_variant_daily_metrics',

  // Notifications
  VENDOR_NOTIFICATION: 'vendor_notifications',
  VENDOR_NOTIFICATION_PREFERENCE: 'vendor_notification_preferences',
  AGENCY_NOTIFICATION: 'agency_notifications',
  AGENCY_NOTIFICATION_PREFERENCE: 'agency_notification_preferences',
  AGENT_NOTIFICATION: 'agent_notifications',
  AGENT_NOTIFICATION_PREFERENCE: 'agent_notification_preferences',
  CUSTOMER_NOTIFICATION: 'customer_notifications',
  CUSTOMER_NOTIFICATION_PREFERENCE: 'customer_notification_preferences',
  DEVICE_TOKEN: 'device_tokens',

  // Integrations
  CONNECTED_CALENDAR_ACCOUNT: 'connected_calendar_accounts',
  // `telegram_links` was declared here and queried by nothing. jovi-mall dropped
  // the collection when messaging connections were unified onto
  // `channel_connections`; wi-admin still has no reason to read either, so the
  // name is simply gone rather than updated.
  CHANNEL_CONNECTION: 'channel_connections',

  // Billing (pricing plans & credit wallet)
  PRICING_PLAN: 'pricing_plans',
  SUBSCRIBER_PLAN: 'subscriber_plans',
  CREDIT_WALLET: 'credit_wallets',
  CREDIT_TRANSACTION: 'credit_transactions',
  CREDIT_TOPUP: 'credit_topups',
  PLAN_PURCHASE: 'plan_purchases',
  BILLING_SETTINGS: 'billing_settings',

  // Earnings (commission, escrow & payout ledger)
  EARNINGS_ACCOUNT: 'earnings_accounts',
  EARNINGS_ALLOCATION: 'earnings_allocations',
  EARNINGS_LEDGER: 'earnings_ledgers',
  EARNINGS_RESERVE_HOLD: 'earnings_reserve_holds',
  PAYOUT_REQUEST: 'payout_requests',

  // Blog / editorial (the marketing site's article pages)
  ARTICLE: 'articles',
  ARTICLE_AUTHOR: 'article_authors',

  // COD (cash on delivery: collections, cash liabilities, reconciliation)
  CASH_COLLECTION: 'cash_collections',
  COD_CASH_ACCOUNT: 'cod_cash_accounts',
  COD_CASH_LEDGER: 'cod_cash_ledgers',
  AGENT_DEPOSIT: 'agent_deposits',
  AGENCY_REMITTANCE: 'agency_remittances',
  COD_DISCREPANCY: 'cod_discrepancies',
  COD_TRUST_EVENT: 'cod_trust_events',

  /**
   * Administrative actions performed on THIS service (Phase 12).
   *
   * Interim: it exists because the dashboard still calls `/api/admin/*` here until the
   * cutover, and those actions were recorded nowhere. wi-admin reads it directly and serves
   * it on a separate, labelled endpoint — it is NOT the compliance record, which is
   * `admin_audit_log` in the `wi-admin` database.
   *
   * Deleted with the legacy surface at cutover.
   */
  ADMIN_ACTION_LOG: 'admin_action_log',
} as const);

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
