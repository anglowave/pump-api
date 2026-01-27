import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, EventParser, Idl } from '@coral-xyz/anchor';
import pumpIdl from '../../config/idl/pump/idl.json';

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/** Decoded BondingCurve account from pump IDL (raw decode may have bigint). */
export interface BondingCurveDecoded {
  virtual_token_reserves: bigint | number;
  virtual_sol_reserves: bigint | number;
  real_token_reserves: bigint | number;
  real_sol_reserves: bigint | number;
  token_total_supply: bigint | number;
  complete: boolean;
  creator: Uint8Array | { toBase58(): string };
  is_mayhem_mode: boolean;
}

/** JSON-serializable BondingCurve shape for wire format. */
export interface BondingCurveUpdateEventData {
  virtual_token_reserves: string;
  virtual_sol_reserves: string;
  real_token_reserves: string;
  real_sol_reserves: string;
  token_total_supply: string;
  complete: boolean;
  creator: string;
  is_mayhem_mode: boolean;
}

/** Event emitted on each bonding curve account update (accountSubscribe). */
export interface BondingCurveUpdateEvent {
  type: 'bonding_curve_update';
  bondingCurve: string;
  data: BondingCurveUpdateEventData;
  slot: number;
  lamports: number;
  sol: number;
}

/** Buy or sell inferred from bonding curve account data (reserve deltas) or from program logs (TradeEvent). */
export interface TradeEvent {
  type: 'buy' | 'sell';
  amount: number;       // SOL amount (from reserve delta or TradeEvent.sol_amount)
  bonding_curve: string;
  slot: number;
  /** Approx token amount from reserve delta or TradeEvent; empty if not derived. */
  token_amount_delta?: string;
  /** Trader wallet (from program TradeEvent logs when available). */
  user?: string;
}

export type TransactionStreamEvent = TradeEvent;

export interface TransactionSubscriptionStatus {
  subscribed: boolean;
  listenerId: number | null;
  error: any;
  lastEventTime: Date | null;
  eventCount: number;
  programId: string | null;
  programType: 'pump' | null;
}

export type TransactionCallback = (event: TransactionStreamEvent) => void;

const PUMP_CODER = new BorshCoder(pumpIdl as Idl);

function toNum(v: bigint | number): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

/** Decode accountNotification / accountSubscribe value into BondingCurve data. value.data can be Buffer or RPC form [base64, "base64"]. */
export function decodeBondingCurveAccountValue(
  value: { lamports?: number; data: Buffer | [string, string] },
  bondingCurve: string,
  slot: number = 0
): BondingCurveUpdateEvent | null {
  const buf = Array.isArray(value.data) && value.data[1] === 'base64' && typeof value.data[0] === 'string'
    ? Buffer.from(value.data[0], 'base64')
    : Buffer.isBuffer(value.data)
      ? value.data
      : null;
  if (!buf || buf.length < 8) return null;
  const accounts = PUMP_CODER.accounts as { decode?: (name: string, data: Buffer) => unknown };
  if (!accounts?.decode) return null;
  let decoded: BondingCurveDecoded;
  try {
    decoded = accounts.decode('BondingCurve', buf) as BondingCurveDecoded;
  } catch {
    return null;
  }
  if (decoded == null || typeof decoded.virtual_token_reserves === 'undefined') return null;
  const toStr = (v: bigint | number) => (typeof v === 'bigint' ? v.toString() : String(v));
  const creator = typeof decoded.creator === 'object' && decoded.creator != null && 'toBase58' in decoded.creator
    ? (decoded.creator as { toBase58(): string }).toBase58()
    : new PublicKey(decoded.creator as Uint8Array).toBase58();
  const lamports = value.lamports ?? 0;
  return {
    type: 'bonding_curve_update',
    bondingCurve,
    data: {
      virtual_token_reserves: toStr(decoded.virtual_token_reserves),
      virtual_sol_reserves: toStr(decoded.virtual_sol_reserves),
      real_token_reserves: toStr(decoded.real_token_reserves),
      real_sol_reserves: toStr(decoded.real_sol_reserves),
      token_total_supply: toStr(decoded.token_total_supply),
      complete: decoded.complete,
      creator,
      is_mayhem_mode: decoded.is_mayhem_mode
    },
    slot,
    lamports,
    sol: lamports / 1_000_000_000
  };
}

/** Decoded TradeEvent from pump program logs (user is the trader pubkey). */
interface PumpTradeEventData {
  is_buy: boolean;
  sol_amount: bigint | number;
  token_amount?: bigint | number;
  user: { toBase58(): string } | Uint8Array;
}

export class TransactionSubscription {
  private connection: Connection;
  private bondingCurve: PublicKey;
  private accountListenerId: number | null = null;
  private logsListenerId: number | null = null;
  private status: TransactionSubscriptionStatus;
  private callbacks: Set<TransactionCallback> = new Set();
  private programId: PublicKey | null = null;
  private eventParser: EventParser | null = null;
  /** Previous decoded reserves to infer buy/sell from account data deltas. */
  private prevReserves: { virtual_sol_reserves: number; virtual_token_reserves: number } | null = null;

  constructor(bondingCurve: string | PublicKey, rpcUrl?: string) {
    const url = rpcUrl || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(url, 'finalized');
    this.bondingCurve = typeof bondingCurve === 'string'
      ? new PublicKey(bondingCurve)
      : bondingCurve;
    this.status = {
      subscribed: false,
      listenerId: null,
      error: null,
      lastEventTime: null,
      eventCount: 0,
      programId: null,
      programType: null
    };
  }

  /** Ensures the account is owned by the pump program (required for BondingCurve decoding). */
  private async ensurePumpBondingCurve(): Promise<void> {
    const accountInfo = await this.connection.getAccountInfo(this.bondingCurve);
    if (!accountInfo) {
      throw new Error(`Bonding curve account not found: ${this.bondingCurve.toString()}`);
    }
    if (!accountInfo.owner.equals(PUMP_PROGRAM_ID)) {
      throw new Error(
        `Bonding curve is not owned by pump program. Owner: ${accountInfo.owner.toString()}. ` +
        `Only pump program (${PUMP_PROGRAM_ID.toString()}) is supported for accountSubscribe + IDL decode.`
      );
    }
    this.programId = accountInfo.owner;
    this.status.programId = this.programId.toString();
    this.status.programType = 'pump';
    console.log(`Bonding curve confirmed as pump program: ${this.bondingCurve.toString()}`);
  }

  /** Normalize accountNotification / accountSubscribe value.data to Buffer. Supports Buffer or RPC form [base64, "base64"]. */
  private dataToBuffer(data: Buffer | [string, string] | unknown): Buffer | null {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data) && data.length >= 2 && data[1] === 'base64' && typeof data[0] === 'string') {
      return Buffer.from(data[0], 'base64');
    }
    return null;
  }

  /** Decode BondingCurve account data using pump IDL. Anchor 0.32 BorshAccountsCoder has decode(name, data), not .layouts. */
  private decodeAccountData(accountData: Buffer): BondingCurveDecoded | null {
    if (accountData.length < 8) return null;
    const accounts = PUMP_CODER.accounts;
    if (!accounts || typeof (accounts as { decode?: (n: string, d: Buffer) => unknown }).decode !== 'function') {
      console.error('[decodeAccountData] coder.accounts.decode not available');
      return null;
    }
    try {
      const decoded = (accounts as { decode(name: string, data: Buffer): BondingCurveDecoded }).decode('BondingCurve', accountData);
      if (decoded != null && typeof decoded.virtual_token_reserves !== 'undefined') {
        return decoded;
      }
    } catch (err) {
      console.warn('[decodeAccountData] accounts.decode threw:', err);
    }
    return null;
  }

  /** Parse program logs for TradeEvent and emit trade with user when present. */
  private handleLogs(logs: string[], context: { slot: number }): void {
    if (!this.eventParser) return;
    const bondingCurveStr = this.bondingCurve.toString();
    try {
      for (const ev of this.eventParser.parseLogs(logs, false)) {
        if (ev.name !== 'TradeEvent') continue;
        const d = ev.data as PumpTradeEventData;
        const amountSol = toNum(d.sol_amount) / 1_000_000_000;
        const userStr =
          typeof d.user === 'object' && d.user != null && 'toBase58' in d.user
            ? (d.user as { toBase58(): string }).toBase58()
            : new PublicKey(d.user as Uint8Array).toBase58();
        const event: TradeEvent = {
          type: d.is_buy ? 'buy' : 'sell',
          amount: amountSol,
          bonding_curve: bondingCurveStr,
          slot: context.slot,
          token_amount_delta: d.token_amount != null ? String(toNum(d.token_amount)) : undefined,
          user: userStr
        };
        this.status.eventCount++;
        this.status.lastEventTime = new Date();
        this.notifyCallbacks(event);
      }
    } catch (err) {
      console.warn('[handleLogs] parse/emit error:', err);
    }
  }

  /**
   * Subscribes via onLogs(mentions bonding curve): parses pump TradeEvent from program logs
   * and emits one event per trade with type, amount, bonding_curve, slot, token_amount_delta, and user (trader).
   */
  async subscribe(): Promise<void> {
    if (this.status.subscribed) {
      throw new Error('Already subscribed');
    }

    try {
      await this.ensurePumpBondingCurve();
      this.eventParser = new EventParser(PUMP_PROGRAM_ID, PUMP_CODER);

      this.logsListenerId = this.connection.onLogs(
        this.bondingCurve,
        (logs, ctx) => this.handleLogs(logs.logs, { slot: ctx.slot }),
        'finalized'
      );

      this.status.subscribed = true;
      this.status.listenerId = this.logsListenerId;
    } catch (error) {
      this.status.error = error;
      console.error('Error subscribing to transaction logs (onLogs):', error);
      if (error instanceof Error) {
        console.error('Error details:', error.message);
        console.error('Error stack:', error.stack);
      }
      throw error;
    }
  }

  unsubscribe(): void {
    if (this.logsListenerId !== null) {
      this.connection.removeOnLogsListener(this.logsListenerId).catch((err) => {
        console.error('Error removing onLogs listener:', err);
      });
      this.logsListenerId = null;
    }
    this.accountListenerId = null;
    this.prevReserves = null;
    this.eventParser = null;
    this.status.subscribed = false;
    this.status.listenerId = null;
  }

  onTransaction(callback: TransactionCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  private notifyCallbacks(event: TransactionStreamEvent): void {
    this.callbacks.forEach((callback) => {
      try {
        callback(event);
      } catch (error) {
        console.error('Error in transaction callback:', error);
      }
    });
  }

  getStatus(): TransactionSubscriptionStatus {
    return { ...this.status };
  }

  getConnection(): Connection {
    return this.connection;
  }

  getBondingCurve(): PublicKey {
    return this.bondingCurve;
  }
}
