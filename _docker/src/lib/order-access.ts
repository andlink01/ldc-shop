type OrderUser = { id?: string; username?: string | null } | null | undefined
type OwnedOrder = { userId: string | null; username?: string | null }

export function isOrderOwner(user: OrderUser, order: OwnedOrder) {
    if (!user?.id) return false
    if (order.userId) return user.id === order.userId
    return Boolean(order.username && user.username === order.username)
}

export function canAccessOrder(user: OrderUser, order: OwnedOrder, orderId: string, pendingCookie?: string) {
    return isOrderOwner(user, order) || (!order.userId && !order.username && pendingCookie === orderId)
}
