/**
 * One switch that lifts the limits a product's customers are held to, for a stretch of testing: PRODUCT_LIMITS=off (set the same in the publisher, review and engine
 * settings). It lifts the weekly pictures of a channel, the redraws of a picture, the one topic and the one carousel a customer may ask for a week, and the new topics
 * of a dropped post. The publisher has the same switch for the batches and the asks for pictures. It does NOT lift the monthly picture ceiling of a brand or the
 * spending limits of the paid-call ledger: those protect the owner's money and stay in force. Anything else (including no setting) leaves every limit as it is.
 */
export const productLimitsOff = (env: Record<string, string | undefined> = process.env): boolean => env['PRODUCT_LIMITS'] === 'off';

/** What a weekly limit becomes when the limits are off: so high it never stops a customer, yet still a number a screen can show. */
export const UNLIMITED = 1000;
