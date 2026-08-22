import { beforeEach, describe, expect, it, vi } from "vitest";

const stripe = vi.hoisted(() => ({ createCheckoutSession: vi.fn() }));

vi.mock("stripe", () => ({
  default: class StripeMock {
    checkout = { sessions: { create: stripe.createCheckoutSession } };
  },
}));

import { createCheckoutSession, type StripeConfig } from "../billing";

const config: StripeConfig = { secretKey: "sk_test_mock", webhookSecret: "whsec_mock" };
const invokeCheckout = createCheckoutSession as unknown as (
  config: StripeConfig,
  customerId: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
  seatQuantity: number,
) => Promise<string>;

beforeEach(() => {
  vi.clearAllMocks();
  stripe.createCheckoutSession.mockResolvedValue({ url: "https://checkout.test/session" });
});

describe("Stripe checkout seat quantity", () => {
  it("carries a Team quantity of 3 into the single subscription line item", async () => {
    await expect(
      invokeCheckout(config, "cus_team", "price_team", "https://app/success", "https://app/cancel", 3),
    ).resolves.toBe("https://checkout.test/session");

    expect(stripe.createCheckoutSession).toHaveBeenCalledExactlyOnceWith({
      customer: "cus_team",
      mode: "subscription",
      line_items: [{ price: "price_team", quantity: 3 }],
      success_url: "https://app/success",
      cancel_url: "https://app/cancel",
    });
  });

  it("keeps Individual quantity exactly 1", async () => {
    await invokeCheckout(config, "cus_individual", "price_individual", "https://app/success", "https://app/cancel", 1);
    expect(stripe.createCheckoutSession.mock.calls[0][0].line_items).toEqual([
      { price: "price_individual", quantity: 1 },
    ]);
  });

  it.each([0, -1, -999])("fails safe to quantity 1 for invalid seat input %s", async (seatQuantity) => {
    await invokeCheckout(config, "cus_team", "price_team", "https://app/success", "https://app/cancel", seatQuantity);
    expect(stripe.createCheckoutSession.mock.calls[0][0].line_items[0].quantity).toBe(1);
  });
});
