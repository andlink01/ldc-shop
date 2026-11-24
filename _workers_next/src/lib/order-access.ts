type OrderUser = { id?: string; username?: string | null } | null | undefined
type OwnedOrder = { userId: string | null; username?: string | null }

/**
 * The only proof of ownership is the signed-in account. A cookie naming the order proves nothing,
 * since any visitor who knows an order number can set it, so an order without an owner has no
 * buyer-side access to its card keys: the administrator hands those out.
 */
export function isOrderOwner(user: OrderUser, order: OwnedOrder) {
    if (!user?.id) return false
    if (order.userId) return user.id === order.userId
    return Boolean(order.username && user.username === order.username)
}
