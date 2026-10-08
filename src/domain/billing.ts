export interface BillingConnection {
  connectionId: string;
  planCode: string;
  priceMinor: number;
  currency: string;
  periodDays: number;
}
export interface PlatformSubscription {
  id: string;
  status: "pending" | "active" | "cancel_pending" | "cancelled" | "past_due" | "unknown";
  providerSubscriptionId: string | null;
  connectionId: string;
  planCode: string;
  amountMinor: number;
  currency: string;
  periodDays: number;
  validUntil: string | null;
  checkoutUrl: string | null;
  sequence: number;
  createdAt: string;
  updatedAt: string;
}
export interface PlatformInvoice {
  id: string;
  providerInvoiceId: string | null;
  subscriptionId: string;
  amountMinor: number;
  currency: string;
  refundedMinor: number;
  status: "pending" | "paid" | "failed" | "void" | "partially_refunded" | "refunded";
  createdAt: string;
  updatedAt: string;
}
export interface PublicPlatformBilling {
  connection: BillingConnection | null;
  configured: boolean;
  subscription: PlatformSubscription | null;
  invoices: PlatformInvoice[];
  remoteBillingVerified: boolean;
  pendingAction: { action: "start" | "cancel" | "reconcile"; idempotencyKey: string } | null;
}
