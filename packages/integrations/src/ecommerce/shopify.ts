/**
 * Shopify Admin API Client
 *
 * Manage products, orders, and customers via Shopify Admin REST API.
 */

export interface ShopifyConfig {
  shopDomain: string;
  accessToken: string;
}

function shopifyBase(config: ShopifyConfig): string {
  const domain = config.shopDomain.replace(/\/$/, "");
  return `https://${domain}/admin/api/2024-01`;
}

function shopifyHeaders(config: ShopifyConfig): Record<string, string> {
  return {
    "X-Shopify-Access-Token": config.accessToken,
    "Content-Type": "application/json",
  };
}

export interface ShopifyProduct {
  title: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  tags?: string;
  status?: "active" | "draft" | "archived";
  variants?: Array<{ price: string; sku?: string; inventory_quantity?: number }>;
}

/**
 * Create a product in Shopify.
 */
export async function createShopifyProduct(
  config: ShopifyConfig,
  product: ShopifyProduct,
): Promise<{ productId: string; handle: string; url: string }> {
  const res = await fetch(`${shopifyBase(config)}/products.json`, {
    method: "POST",
    headers: shopifyHeaders(config),
    body: JSON.stringify({ product }),
  });

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Shopify create product failed: ${JSON.stringify(err?.errors ?? res.status)}`);
  }

  const data: any = await res.json();
  const p = data.product;
  return {
    productId: String(p.id),
    handle: p.handle,
    url: `https://${config.shopDomain}/products/${p.handle}`,
  };
}

/**
 * Get a list of orders.
 */
export async function listShopifyOrders(
  config: ShopifyConfig,
  status = "any",
  limit = 50,
): Promise<Array<{ id: string; orderNumber: number; totalPrice: string; status: string }>> {
  const res = await fetch(
    `${shopifyBase(config)}/orders.json?status=${status}&limit=${limit}`,
    { headers: shopifyHeaders(config) },
  );

  if (!res.ok) {
    throw new Error(`Shopify list orders failed: ${res.status}`);
  }

  const data: any = await res.json();
  return (data.orders ?? []).map((o: any) => ({
    id: String(o.id),
    orderNumber: o.order_number,
    totalPrice: o.total_price,
    status: o.financial_status,
  }));
}

/**
 * Update an order (add note, tags).
 */
export async function updateShopifyOrder(
  config: ShopifyConfig,
  orderId: string,
  updates: { note?: string; tags?: string },
): Promise<void> {
  const res = await fetch(`${shopifyBase(config)}/orders/${orderId}.json`, {
    method: "PUT",
    headers: shopifyHeaders(config),
    body: JSON.stringify({ order: updates }),
  });

  if (!res.ok) {
    throw new Error(`Shopify update order failed: ${res.status}`);
  }
}

/**
 * Get shop info to test connection.
 */
export async function testShopifyConnection(
  config: ShopifyConfig,
): Promise<{ ok: boolean; shopName: string; plan: string }> {
  const res = await fetch(`${shopifyBase(config)}/shop.json`, {
    headers: shopifyHeaders(config),
  });

  if (!res.ok) {
    throw new Error(`Shopify connection test failed: ${res.status}`);
  }

  const data: any = await res.json();
  return {
    ok: true,
    shopName: data.shop?.name ?? "",
    plan: data.shop?.plan_name ?? "",
  };
}
