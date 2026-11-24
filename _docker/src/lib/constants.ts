export const INFINITE_STOCK = 999999;
export const RESERVATION_TTL_MS = 5 * 60 * 1000;
// Unpaid orders hold stock, so one account may only keep a few open and
// abandon a bounded number per hour.
export const MAX_PENDING_ORDERS_PER_USER = 5;
export const MAX_UNPAID_ORDERS_PER_HOUR = 20;
export const UNPAID_ORDER_WINDOW_MS = 60 * 60 * 1000;
export const MAX_USER_MESSAGES_PER_WINDOW = 5;
export const MAX_REVIEW_REPLIES_PER_WINDOW = 10;
export const USER_CONTENT_WINDOW_MS = 10 * 60 * 1000;
export const MAX_REVIEW_COMMENT_LENGTH = 1000;
