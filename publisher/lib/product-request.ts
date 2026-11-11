import { apiError } from './api-error.js';
import { describeError } from './http.js';
import { authenticateProduct, parseProducts, type Product } from './products.js';

/** The product a request comes from, or the response to send instead (401 for an unknown key, 500 for bad settings). */
export function productOf(request: Request): Product | Response {
  let products: Product[];
  try {
    products = parseProducts(process.env['PRODUCTS']);
  } catch (error) {
    console.error(describeError(error));
    return apiError(500, 'SERVICE_NOT_CONFIGURED', 'the service is not configured correctly');
  }
  return authenticateProduct(request, products) ?? apiError(401, 'UNAUTHORIZED', 'unauthorized');
}
