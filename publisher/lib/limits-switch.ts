/**
 * The switch that lifts the limits a product's customers are held to, for a stretch of testing: PRODUCT_LIMITS=off (the same setting is read by the poster service).
 * Here it lifts the batches a customer may start (a day, a month) and the times she may ask for pictures. It does not lift the spending limits of the paid-call ledger or
 * the monthly picture ceiling of a brand. Anything else, including no setting, leaves every limit as it is.
 */
export const productLimitsOff = (env: Record<string, string | undefined> = process.env): boolean => env['PRODUCT_LIMITS'] === 'off';
