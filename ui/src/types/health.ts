/** Wire shape of GET /healthz. Duplicated from backend — no cross-import. */
export interface HealthzResponse {
  status: 'ok';
  version: string;
}
