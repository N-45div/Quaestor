/**
 * Type shims for @okxweb3 x402 packages: they ship export-map-only type
 * declarations (.d.mts) that classic moduleResolution can't see. Runtime
 * resolution (Node's require with exports maps) works fine; these shims
 * cover the type layer only.
 */

declare module "@okxweb3/x402-express" {
  export const paymentMiddleware: (...args: any[]) => any;
  export class x402ResourceServer {
    constructor(facilitator: any);
    register(network: string, scheme: any): this;
  }
}

declare module "@okxweb3/x402-evm/exact/server" {
  export class ExactEvmScheme {
    constructor(...args: any[]);
  }
}

declare module "@okxweb3/x402-core" {
  export interface OKXConfig {
    apiKey: string;
    secretKey: string;
    passphrase: string;
    baseUrl?: string;
    syncSettle?: boolean;
  }
  export class OKXFacilitatorClient {
    constructor(config: OKXConfig);
  }
}
