/**
 * The page of an order, or null when the value cannot be an order number. The value comes from a
 * return URL anyone can craft, so dots and slashes must never reach the path: "../../admin" would
 * turn the payment return address into a redirect to any page of the shop.
 */
export function orderPagePath(value: string | null | undefined): string | null {
    const orderId = (value || '').trim()
    return /^[A-Za-z0-9_-]{1,80}$/.test(orderId) ? `/order/${orderId}` : null
}
