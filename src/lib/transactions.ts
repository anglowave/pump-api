import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, EventParser, Idl } from '@coral-xyz/anchor';
import pumpIdl from '../../config/idl/pump/idl.json';
import pumpAmmIdl from '../../config/idl/pump_amm/idl.json';

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

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

export interface BondingCurveUpdateEvent {
  type: 'bonding_curve_update';
  bondingCurve: string;
  data: BondingCurveUpdateEventData;
  slot: number;
  lamports: number;
  sol: number;
}

export interface TradeEvent {
  type: 'buy' | 'sell';
  amount: number;       
  bonding_curve: string;
  slot: number;
  token_amount_delta?: string;
  user?: string;
  signature?: string;
}

export type TransactionStreamEvent = TradeEvent;

export interface TransactionSubscriptionStatus {
  subscribed: boolean;
  listenerId: number | null;
  error: any;
  lastEventTime: Date | null;
  eventCount: number;
  programId: string | null;
  programType: 'pump' | 'pump_amm' | null;
}

export type TransactionCallback = (event: TransactionStreamEvent) => void;

const PUMP_CODER = new BorshCoder(pumpIdl as Idl);
const PUMP_AMM_CODER = new BorshCoder(pumpAmmIdl as Idl);

function toNum(v: bigint | number): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

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

interface PumpTradeEventData {
  mint: { toBase58(): string } | Uint8Array;
  sol_amount: bigint | number;
  token_amount: bigint | number;
  is_buy: boolean;
  user: { toBase58(): string } | Uint8Array;
  timestamp: bigint | number;
  virtual_sol_reserves: bigint | number;
  virtual_token_reserves: bigint | number;
  real_sol_reserves: bigint | number;
  real_token_reserves: bigint | number;
  fee_recipient: { toBase58(): string } | Uint8Array;
  fee_basis_points: bigint | number;
  fee: bigint | number;
  creator: { toBase58(): string } | Uint8Array;
  creator_fee_basis_points: bigint | number;
  creator_fee: bigint | number;
  track_volume: boolean;
  total_unclaimed_tokens: bigint | number;
  total_claimed_tokens: bigint | number;
  current_sol_volume: bigint | number;
  last_update_timestamp: bigint | number;
  ix_name: string;
  mayhem_mode: boolean;
}

interface PumpAmmBuyEventData {
  pool: { equals(pk: PublicKey): boolean } | Uint8Array;
  user: { toBase58(): string } | Uint8Array;
  quote_amount_in: bigint | number;
  base_amount_out: bigint | number;
  [key: string]: unknown;
}

interface PumpAmmSellEventData {
  pool: { equals(pk: PublicKey): boolean } | Uint8Array;
  user: { toBase58(): string } | Uint8Array;
  base_amount_in: bigint | number;
  quote_amount_out: bigint | number;
  [key: string]: unknown;
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
  private accountCoder: BorshCoder = PUMP_CODER;
  private prevReserves: { virtual_sol_reserves: number; virtual_token_reserves: number } | null = null;
  private pendingTrades: Map<number, { event: TradeEvent; timestamp: number }> = new Map();

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

  private async ensurePumpBondingCurve(): Promise<void> {
    const accountInfo = await this.connection.getAccountInfo(this.bondingCurve);
    if (!accountInfo) {
      throw new Error(`Bonding curve account not found: ${this.bondingCurve.toString()}`);
    }
    const owner = accountInfo.owner;
    if (owner.equals(PUMP_PROGRAM_ID)) {
      this.programId = owner;
      this.status.programId = this.programId.toString();
      this.status.programType = 'pump';
      this.accountCoder = PUMP_CODER;
    } else if (owner.equals(PUMP_AMM_PROGRAM_ID)) {
      this.programId = owner;
      this.status.programId = this.programId.toString();
      this.status.programType = 'pump_amm';
      this.accountCoder = PUMP_AMM_CODER;
    } else {
      throw new Error(
        `Bonding curve is not owned by pump or pump_amm. Owner: ${owner.toString()}. ` +
        `Supported: pump (${PUMP_PROGRAM_ID.toString()}), pump_amm (${PUMP_AMM_PROGRAM_ID.toString()}).`
      );
    }
  }

  private dataToBuffer(data: Buffer | [string, string] | unknown): Buffer | null {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data) && data.length >= 2 && data[1] === 'base64' && typeof data[0] === 'string') {
      return Buffer.from(data[0], 'base64');
    }
    return null;
  }

  private decodeAccountData(accountData: Buffer): BondingCurveDecoded | null {
    if (accountData.length < 8) return null;
    const accounts = this.accountCoder.accounts;
    if (!accounts || typeof (accounts as { decode?: (n: string, d: Buffer) => unknown }).decode !== 'function') {
      return null;
    }
    try {
      const decoded = (accounts as { decode(name: string, data: Buffer): BondingCurveDecoded }).decode('BondingCurve', accountData);
      if (decoded != null && typeof decoded.virtual_token_reserves !== 'undefined') {
        return decoded;
      }
    } catch (err) {
    }
    return null;
  }

  private handleAccountChange(accountInfo: { data: Buffer | [string, string]; lamports: number }, context: { slot: number }): void {
    const bondingCurveStr = this.bondingCurve.toString();
    
    try {
      const accountData = this.dataToBuffer(accountInfo.data);
      if (!accountData) {
        return;
      }
      
      const decoded = this.decodeAccountData(accountData);
      if (!decoded) {
        return;
      }
      
      if (this.prevReserves) {
        const prevSol = this.prevReserves.virtual_sol_reserves;
        const prevToken = this.prevReserves.virtual_token_reserves;
        const currSol = toNum(decoded.virtual_sol_reserves);
        const currToken = toNum(decoded.virtual_token_reserves);
        
        const solDelta = currSol - prevSol;
        const tokenDelta = prevToken - currToken;
        
        if (solDelta > 0 && tokenDelta > 0) {
          const amountSol = solDelta / 1_000_000_000;
          const creatorStr = typeof decoded.creator === 'object' && decoded.creator != null && 'toBase58' in decoded.creator
            ? (decoded.creator as { toBase58(): string }).toBase58()
            : new PublicKey(decoded.creator as Uint8Array).toBase58();
          const event: TradeEvent = {
            type: 'buy',
            bonding_curve: bondingCurveStr,
            amount: amountSol,
            slot: context.slot,
            token_amount_delta: String(tokenDelta),
            user: creatorStr,
          };
          
          this.pendingTrades.set(context.slot, { event, timestamp: Date.now() });
          
          setTimeout(() => {
            const pending = this.pendingTrades.get(context.slot);
            if (pending) {
              this.pendingTrades.delete(context.slot);
              this.status.eventCount++;
              this.status.lastEventTime = new Date();
              this.notifyCallbacks(pending.event);
            }
          }, 2000);
        } else if (solDelta < 0 && tokenDelta < 0) {
          const amountSol = Math.abs(solDelta) / 1_000_000_000;
          const event: TradeEvent = {
            type: 'sell',
            amount: amountSol,
            bonding_curve: bondingCurveStr,
            slot: context.slot,
            token_amount_delta: String(Math.abs(tokenDelta)),
          };
          
          this.pendingTrades.set(context.slot, { event, timestamp: Date.now() });
          
          setTimeout(() => {
            const pending = this.pendingTrades.get(context.slot);
            if (pending) {
              this.pendingTrades.delete(context.slot);
              this.status.eventCount++;
              this.status.lastEventTime = new Date();
              this.notifyCallbacks(pending.event);
            }
          }, 2000);
        }
      }
      
      this.prevReserves = {
        virtual_sol_reserves: toNum(decoded.virtual_sol_reserves),
        virtual_token_reserves: toNum(decoded.virtual_token_reserves)
      };
      
      const now = Date.now();
      for (const [slot, pending] of this.pendingTrades.entries()) {
        if (now - pending.timestamp > 10000) {
          this.pendingTrades.delete(slot);
        }
      }
    } catch (err) {
    }
  }

  private pubkeyEquals(a: { equals(pk: PublicKey): boolean } | Uint8Array, b: PublicKey): boolean {
    if (a != null && typeof a === 'object' && 'equals' in a && typeof (a as { equals: (p: PublicKey) => boolean }).equals === 'function') {
      return (a as { equals(pk: PublicKey): boolean }).equals(b);
    }
    try {
      return new PublicKey(a as Uint8Array).equals(b);
    } catch {
      return false;
    }
  }

  private handleLogs(logs: { logs: string[]; err?: any }, context: { slot: number; signature?: string }): void {
    if (!this.eventParser) return;
    
    try {
      const parsedEvents = Array.from(this.eventParser.parseLogs(logs.logs, false));
      const bondingCurveStr = this.bondingCurve.toString();
      const isAmm = this.status.programType === 'pump_amm';

      for (const ev of parsedEvents) {
        if (isAmm) {
          if (ev.name === 'BuyEvent') {
            const d = ev.data as PumpAmmBuyEventData;
            if (!this.pubkeyEquals(d.pool, this.bondingCurve)) continue;
            const userStr = typeof d.user === 'object' && d.user != null && 'toBase58' in d.user
              ? (d.user as { toBase58(): string }).toBase58()
              : new PublicKey(d.user as Uint8Array).toBase58();
            const amountSol = toNum(d.quote_amount_in) / 1_000_000_000;
            const event: TradeEvent = {
              type: 'buy',
              amount: amountSol,
              bonding_curve: bondingCurveStr,
              slot: context.slot,
              token_amount_delta: String(toNum(d.base_amount_out)),
              user: userStr,
              signature: context.signature
            };
            this.status.eventCount++;
            this.status.lastEventTime = new Date();
            this.notifyCallbacks(event);
          } else if (ev.name === 'SellEvent') {
            const d = ev.data as PumpAmmSellEventData;
            if (!this.pubkeyEquals(d.pool, this.bondingCurve)) continue;
            const userStr = typeof d.user === 'object' && d.user != null && 'toBase58' in d.user
              ? (d.user as { toBase58(): string }).toBase58()
              : new PublicKey(d.user as Uint8Array).toBase58();
            const amountSol = toNum(d.quote_amount_out) / 1_000_000_000;
            const event: TradeEvent = {
              type: 'sell',
              amount: amountSol,
              bonding_curve: bondingCurveStr,
              slot: context.slot,
              token_amount_delta: String(toNum(d.base_amount_in)),
              user: userStr,
              signature: context.signature
            };
            this.status.eventCount++;
            this.status.lastEventTime = new Date();
            this.notifyCallbacks(event);
          }
          continue;
        }

        if (ev.name !== 'TradeEvent') continue;
        
        const d = ev.data as PumpTradeEventData;
        const creatorStr =
          typeof d.creator === 'object' && d.creator != null && 'toBase58' in d.creator
            ? (d.creator as { toBase58(): string }).toBase58()
            : new PublicKey(d.creator as Uint8Array).toBase58();
        
        const amountSol = toNum(d.sol_amount) / 1_000_000_000;
        
        let matched = false;
        for (let slotOffset = -5; slotOffset <= 5; slotOffset++) {
          const checkSlot = context.slot + slotOffset;
          const pending = this.pendingTrades.get(checkSlot);
          if (pending) {
            const enrichedEvent: TradeEvent = {
              ...pending.event,
              user: creatorStr,
              signature: context.signature,
              amount: amountSol
            };
            
            this.pendingTrades.delete(checkSlot);
            this.status.eventCount++;
            this.status.lastEventTime = new Date();
            this.notifyCallbacks(enrichedEvent);
            matched = true;
            break;
          }
        }
        
        if (!matched) {
          const event: TradeEvent = {
            type: d.is_buy ? 'buy' : 'sell',
            amount: amountSol,
            bonding_curve: bondingCurveStr,
            slot: context.slot,
            token_amount_delta: String(toNum(d.token_amount)),
            user: creatorStr,
            signature: context.signature
          };
          
          this.status.eventCount++;
          this.status.lastEventTime = new Date();
          this.notifyCallbacks(event);
        }
      }
    } catch (err) {
    }
  }

  async subscribe(): Promise<void> {
    if (this.status.subscribed) {
      throw new Error('Already subscribed');
    }

    try {
      await this.ensurePumpBondingCurve();
      this.eventParser = new EventParser(this.programId!, this.accountCoder);
      
      const bondingCurveStr = this.bondingCurve.toString();
      
      const initialAccountInfo = await this.connection.getAccountInfo(this.bondingCurve, 'finalized');
      if (initialAccountInfo) {
        const initialDecoded = this.decodeAccountData(initialAccountInfo.data);
        if (initialDecoded) {
          this.prevReserves = {
            virtual_sol_reserves: toNum(initialDecoded.virtual_sol_reserves),
            virtual_token_reserves: toNum(initialDecoded.virtual_token_reserves)
          };
        }
      }
      
      this.accountListenerId = this.connection.onAccountChange(
        this.bondingCurve,
        (accountInfo, context) => {
          const accountData: Buffer | [string, string] | unknown = accountInfo.data;
          this.handleAccountChange(
            {
              data: accountData as Buffer | [string, string],
              lamports: accountInfo.lamports
            },
            { slot: context.slot }
          );
        },
        'finalized'
      );
      
      this.logsListenerId = this.connection.onLogs(
        this.bondingCurve,
        (logs, ctx) => {
          const signature = (ctx as any).signature || (ctx as any).transaction?.signatures?.[0];
          this.handleLogs(logs, { slot: ctx.slot, signature });
        },
        'finalized'
      );

      this.status.subscribed = true;
      this.status.listenerId = this.accountListenerId;
    } catch (error) {
      this.status.error = error;
      throw error;
    }
  }

  unsubscribe(): void {
    if (this.accountListenerId !== null) {
      this.connection.removeAccountChangeListener(this.accountListenerId).catch(() => {});
      this.accountListenerId = null;
    }
    if (this.logsListenerId !== null) {
      this.connection.removeOnLogsListener(this.logsListenerId).catch(() => {});
      this.logsListenerId = null;
    }
    this.prevReserves = null;
    this.eventParser = null;
    this.pendingTrades.clear();
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
