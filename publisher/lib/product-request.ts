import { describeError, json } from './http.js';
import { authenticateProduct, parseProducts, type Product } from './products.js';

/** The product a request comes from, or the response to send instead (401 for an unknown key, 500 for bad settings). */
export function productOf(request: Request): Product | Response {
  let products: Product[];
  try {
    products = parseProducts(process.env['PRODUCTS']);
  } catch (error) {
    console.error(describeError(error));
    return json(500, { error: 'the service is not configured correctly' });
  }
  return authenticateProduct(request, products) ?? json(401, { error: 'unauthorized' });
}
