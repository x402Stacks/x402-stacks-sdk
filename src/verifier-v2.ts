/**
 * x402-stacks - Payment Verifier (Coinbase Compatible)
 * Handles verification and settlement of payments using x402 protocol
 */

import axios, { AxiosInstance } from 'axios';
import { AuthType, deserializeTransaction } from '@stacks/transactions';
import {
  NetworkV2,
  PaymentRequirementsV2,
  PaymentPayloadV2,
  VerifyResponseV2,
  SettlementResponseV2,
  FacilitatorVerifyRequestV2,
  FacilitatorSettleRequestV2,
  SupportedResponse,
  X402_ERROR_CODES,
} from './types-v2';
import { assetFromV2 } from './utils';

/**
 * Options for verifying a payment
 */
export interface VerifyOptions {
  /** Payment requirements from the resource server */
  paymentRequirements: PaymentRequirementsV2;
}

/**
 * Options for settling a payment
 */
export interface SettleOptions {
  /** Payment requirements from the resource server */
  paymentRequirements: PaymentRequirementsV2;
}

/**
 * Optional verifier configuration
 */
export interface X402PaymentVerifierOptions {
  /**
   * Optional sponsor relay URL. When configured, sponsored transactions are
   * settled through the relay instead of the facilitator.
   */
  relayUrl?: string;
}

interface RelaySettleRequest {
  transaction: string;
  settle: {
    expectedRecipient: string;
    minAmount: string;
    tokenType: 'STX' | 'sBTC' | 'USDCx';
    resource?: string;
  };
}

interface RelaySettleResponse {
  success: boolean;
  txid?: string;
  error?: string;
  code?: string;
  settlement?: {
    success?: boolean;
    sender?: string;
    senderAddress?: string;
  };
}

function stripHexPrefix(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value;
}

function withHexPrefix(value: string): string {
  return value.startsWith('0x') ? value : `0x${value}`;
}

function isSponsoredTransaction(transactionHex: string): boolean {
  try {
    const raw = Buffer.from(stripHexPrefix(transactionHex), 'hex');
    const tx = deserializeTransaction(raw);
    return tx.auth.authType === AuthType.Sponsored;
  } catch {
    return false;
  }
}

function relayTokenTypeFromAsset(asset: string): 'STX' | 'sBTC' | 'USDCx' {
  const tokenType = assetFromV2(asset).tokenType;

  if (tokenType === 'sBTC') return 'sBTC';
  if (tokenType === 'USDCx') return 'USDCx';
  return 'STX';
}

/**
 * Payment verifier for validating x402 payments on Stacks
 * Compatible with Coinbase x402 protocol
 */
export class X402PaymentVerifier {
  private facilitatorUrl: string;
  private relayUrl?: string;
  private httpClient: AxiosInstance;

  constructor(
    facilitatorUrl: string = 'http://localhost:8085',
    options: X402PaymentVerifierOptions = {}
  ) {
    this.facilitatorUrl = facilitatorUrl.replace(/\/$/, ''); // Remove trailing slash
    this.relayUrl = options.relayUrl?.replace(/\/$/, '');

    this.httpClient = axios.create({
      timeout: 30000, // V2 may need longer timeout for settlement
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Verify a payment using the V2 facilitator API
   * This verifies the signed transaction without broadcasting it
   */
  async verify(
    paymentPayload: PaymentPayloadV2,
    options: VerifyOptions
  ): Promise<VerifyResponseV2> {
    try {
      const request: FacilitatorVerifyRequestV2 = {
        x402Version: 2,
        paymentPayload,
        paymentRequirements: options.paymentRequirements,
      };

      const response = await this.httpClient.post<VerifyResponseV2>(
        `${this.facilitatorUrl}/verify`,
        request
      );

      return response.data;
    } catch (error: unknown) {
      // Handle API errors
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as VerifyResponseV2;
        return {
          isValid: false,
          invalidReason: errorData.invalidReason || X402_ERROR_CODES.UNEXPECTED_VERIFY_ERROR,
          payer: errorData.payer,
        };
      }

      return {
        isValid: false,
        invalidReason: X402_ERROR_CODES.UNEXPECTED_VERIFY_ERROR,
      };
    }
  }

  /**
   * Settle a payment using the V2 facilitator API
   * This broadcasts the transaction and waits for confirmation
   */
  async settle(
    paymentPayload: PaymentPayloadV2,
    options: SettleOptions
  ): Promise<SettlementResponseV2> {
    if (this.relayUrl && isSponsoredTransaction(paymentPayload.payload.transaction)) {
      return this.settleViaRelay(paymentPayload, options);
    }

    return this.settleViaFacilitator(paymentPayload, options);
  }

  private async settleViaFacilitator(
    paymentPayload: PaymentPayloadV2,
    options: SettleOptions
  ): Promise<SettlementResponseV2> {
    try {
      const request: FacilitatorSettleRequestV2 = {
        x402Version: 2,
        paymentPayload,
        paymentRequirements: options.paymentRequirements,
      };

      const response = await this.httpClient.post<SettlementResponseV2>(
        `${this.facilitatorUrl}/settle`,
        request
      );

      return response.data;
    } catch (error: unknown) {
      // Handle API errors
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as SettlementResponseV2;
        return {
          success: false,
          errorReason: errorData.errorReason || X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR,
          payer: errorData.payer,
          transaction: errorData.transaction || '',
          network: errorData.network || options.paymentRequirements.network,
        };
      }

      return {
        success: false,
        errorReason: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR,
        transaction: '',
        network: options.paymentRequirements.network,
      };
    }
  }

  private async settleViaRelay(
    paymentPayload: PaymentPayloadV2,
    options: SettleOptions
  ): Promise<SettlementResponseV2> {
    const relayUrl = this.relayUrl;
    if (!relayUrl) {
      return this.settleViaFacilitator(paymentPayload, options);
    }

    try {
      const request: RelaySettleRequest = {
        transaction: withHexPrefix(paymentPayload.payload.transaction),
        settle: {
          expectedRecipient: options.paymentRequirements.payTo,
          minAmount: options.paymentRequirements.amount,
          tokenType: relayTokenTypeFromAsset(options.paymentRequirements.asset),
          resource: paymentPayload.resource?.url,
        },
      };

      const response = await this.httpClient.post<RelaySettleResponse>(
        `${relayUrl}/relay`,
        request
      );

      const relay = response.data;
      if (!relay.success) {
        return {
          success: false,
          errorReason:
            relay.code || relay.error || X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR,
          payer: relay.settlement?.sender || relay.settlement?.senderAddress,
          transaction: relay.txid || '',
          network: options.paymentRequirements.network,
        };
      }

      return {
        success: true,
        payer: relay.settlement?.sender || relay.settlement?.senderAddress,
        transaction: relay.txid || '',
        network: options.paymentRequirements.network,
      };
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        const relay = error.response.data as Partial<RelaySettleResponse>;
        return {
          success: false,
          errorReason:
            relay.code || relay.error || X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR,
          payer: relay.settlement?.sender || relay.settlement?.senderAddress,
          transaction: relay.txid || '',
          network: options.paymentRequirements.network,
        };
      }

      return {
        success: false,
        errorReason: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR,
        transaction: '',
        network: options.paymentRequirements.network,
      };
    }
  }

  /**
   * Get supported payment kinds from the facilitator
   */
  async getSupported(): Promise<SupportedResponse> {
    try {
      const response = await this.httpClient.get<SupportedResponse>(
        `${this.facilitatorUrl}/supported`
      );

      return response.data;
    } catch (error: unknown) {
      // Return empty supported response on error
      return {
        kinds: [],
        extensions: [],
        signers: {},
      };
    }
  }

  /**
   * Check if a specific payment kind is supported
   */
  async isKindSupported(
    network: NetworkV2,
    scheme: string = 'exact',
    x402Version: number = 2
  ): Promise<boolean> {
    const supported = await this.getSupported();

    return supported.kinds.some(
      (kind) =>
        kind.x402Version === x402Version &&
        kind.scheme === scheme &&
        kind.network === network
    );
  }

  /**
   * Verify and settle in one operation
   * First verifies the payment, then settles if valid
   */
  async verifyAndSettle(
    paymentPayload: PaymentPayloadV2,
    options: VerifyOptions & SettleOptions
  ): Promise<SettlementResponseV2> {
    // First verify
    const verifyResult = await this.verify(paymentPayload, options);

    if (!verifyResult.isValid) {
      return {
        success: false,
        errorReason: verifyResult.invalidReason || X402_ERROR_CODES.UNEXPECTED_VERIFY_ERROR,
        payer: verifyResult.payer,
        transaction: '',
        network: options.paymentRequirements.network,
      };
    }

    // Then settle
    return this.settle(paymentPayload, options);
  }

  /**
   * Create a payment payload from a signed transaction
   * Helper for constructing V2 payment payloads
   */
  static createPaymentPayload(
    signedTransaction: string,
    paymentRequirements: PaymentRequirementsV2
  ): PaymentPayloadV2 {
    return {
      x402Version: 2,
      accepted: paymentRequirements,
      payload: {
        transaction: signedTransaction,
      },
    };
  }

  /**
   * Quick check if a payment is valid (returns boolean only)
   */
  async isPaymentValid(
    paymentPayload: PaymentPayloadV2,
    options: VerifyOptions
  ): Promise<boolean> {
    const result = await this.verify(paymentPayload, options);
    return result.isValid;
  }
}

/**
 * Create a verifier instance
 */
export function createVerifier(
  facilitatorUrl?: string,
  options?: X402PaymentVerifierOptions
): X402PaymentVerifier {
  return new X402PaymentVerifier(facilitatorUrl, options);
}

// ===== Backward Compatibility Aliases =====
/** @deprecated Use X402PaymentVerifier instead */
export const X402PaymentVerifierV2 = X402PaymentVerifier;
/** @deprecated Use createVerifier instead */
export const createVerifierV2 = createVerifier;
/** @deprecated Use VerifyOptions instead */
export type VerifyOptionsV2 = VerifyOptions;
/** @deprecated Use SettleOptions instead */
export type SettleOptionsV2 = SettleOptions;
