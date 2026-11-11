/** What every product API call about a customer's content needs first: the workspace the calling product owns, and the engine scoped to it. */
import { apiError } from './api-error.js';
import { findWorkspace, isExternalId } from './clients.js';
import { engineFromEnv, WorkspaceEngine } from './engine-client.js';
import { productOf } from './product-request.js';
import { loadClients, storeConfigured } from './store.js';

export interface Workspace {
  brand: string;
  website: string | undefined;
  /** The customer put this brand away: nothing new is written, drawn or sent for it. */
  archived: boolean;
}

/** The workspace named by externalId, if the calling product owns it; otherwise the response to send. */
export async function workspaceFor(request: Request, externalId: unknown): Promise<{ product: { id: string }; workspace: Workspace } | Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return apiError(503, 'STORAGE_NOT_SET_UP', 'storage is not set up');
  if (!isExternalId(externalId)) return apiError(400, 'INVALID_EXTERNAL_ID', 'externalId is required');
  const { file } = await loadClients();
  const found = findWorkspace(file, product.id, externalId);
  return found ? { product, workspace: { brand: found.brand, website: found.website, archived: found.archived === true } } : apiError(404, 'WORKSPACE_NOT_FOUND', 'no such workspace');
}

/** The answer to send when a call that writes, draws or spends is made for a brand that was put away; null when it may go ahead. */
export const archivedAnswer = (workspace: Workspace): Response | null => (workspace.archived ? apiError(409, 'WORKSPACE_ARCHIVED', 'This brand is put away. Bring it back to use it again.') : null);

/** The engine for one workspace, or the answer to send when the engine is not set up for this product. */
export function engineFor(productId: string, brand: string): WorkspaceEngine | Response {
  const config = engineFromEnv();
  return config && config.productSecrets[productId] !== undefined ? new WorkspaceEngine(config, productId, brand) : apiError(503, 'ENGINE_UNAVAILABLE', 'the poster service is not set up');
}
