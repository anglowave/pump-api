import { Connection, PublicKey, AccountInfo } from '@solana/web3.js';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import pumpIdl from '../../config/idl/pump/idl.json';
import pumpAmmIdl from '../../config/idl/pump_amm/idl.json';

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

const TRADE_EVENT_DISCRIMINATOR = [189, 219, 127, 211, 78, 230, 97, 238];
const BUY_EVENT_DISCRIMINATOR = [103, 244, 82, 31, 44, 245, 119, 119];
const SELL_EVENT_DISCRIMINATOR = [62, 47, 55, 10, 165, 3, 220, 42];

export interface TransactionEvent {
  type: 'buy' | 'sell';
  amount: number; // Amount in SOL
  signature: string;
  timestamp: number; // Unix timestamp in seconds
}

export interface TransactionSubscriptionStatus {
  subscribed: boolean;
  listenerId: number | null;
  error: any;
  lastEventTime: Date | null;
  eventCount: number;
  programId: string | null;
  programType: 'pump' | 'pump_amm' | null;
}

export type TransactionCallback = (event: TransactionEvent) => void;

export class TransactionSubscription {
  private connection: Connection;
  private bondingCurve: PublicKey;
  private subscriptionId: number | null = null;
  private status: TransactionSubscriptionStatus;
  private callbacks: Set<TransactionCallback> = new Set();
  private programId: PublicKey | null = null;
  private programType: 'pump' | 'pump_amm' | null = null;
  private coder: BorshCoder | null = null;
  private accountListenerId: number | null = null;
  private logsListenerId: number | null = null;
  private latestAccountData: { data: any; lamports: number; sol: number; slot: number } | null = null;

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

  private async determineProgramType(): Promise<void> {
    try {
      const accountInfo = await this.connection.getAccountInfo(this.bondingCurve);
      
      if (!accountInfo) {
        throw new Error(`Bonding curve account not found: ${this.bondingCurve.toString()}`);
      }

      this.programId = accountInfo.owner;
      
      if (this.programId.equals(PUMP_PROGRAM_ID)) {
        this.programType = 'pump';
        this.coder = new BorshCoder(pumpIdl as Idl);
      } else if (this.programId.equals(PUMP_AMM_PROGRAM_ID)) {
        this.programType = 'pump_amm';
        this.coder = new BorshCoder(pumpAmmIdl as Idl);
      } else {
        throw new Error(`Unknown program owner: ${this.programId.toString()}. Expected pump or pump_amm program.`);
      }

      this.status.programId = this.programId.toString();
      this.status.programType = this.programType;
      
      console.log(`Determined program type: ${this.programType} (${this.programId.toString()})`);
    } catch (error) {
      console.error('Error determining program type:', error);
      throw error;
    }
  }

  private decodeEvent(logData: string, eventType: 'TradeEvent' | 'BuyEvent' | 'SellEvent'): any | null {
    if (!this.coder) {
      return null;
    }

    try {
      const dataBuffer = Buffer.from(logData, 'base64');
      
      if (dataBuffer.length < 8) {
        return null;
      }
      
      const discriminator = Array.from(dataBuffer.slice(0, 8));
      const eventData = dataBuffer.slice(8);
      
      let expectedDiscriminator: number[];
      if (eventType === 'TradeEvent') {
        expectedDiscriminator = TRADE_EVENT_DISCRIMINATOR;
      } else if (eventType === 'BuyEvent') {
        expectedDiscriminator = BUY_EVENT_DISCRIMINATOR;
      } else {
        expectedDiscriminator = SELL_EVENT_DISCRIMINATOR;
      }
      
      const isMatch = discriminator.every((byte, index) => byte === expectedDiscriminator[index]);
      
      if (!isMatch) {
        return null;
      }
      
      try {
        const eventsCoder = this.coder.events as any;
        
        if (eventsCoder && eventsCoder.layouts && eventsCoder.layouts[eventType]) {
          const eventLayout = eventsCoder.layouts[eventType];
          const decoded = eventLayout.decode(eventData);
          if (decoded !== null && decoded !== undefined) {
            return decoded;
          }
        }
        
        if (eventsCoder && typeof eventsCoder.decode === 'function') {
          try {
            const decoded = eventsCoder.decode(dataBuffer);
            if (decoded && decoded.data) {
              return decoded.data;
            }
          } catch (decodeError) {
          }
        }
      } catch (error) {
        console.error(`Failed to decode ${eventType}:`, error);
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  private parseLogsForEvents(logs: string[]): Array<{ type: 'buy' | 'sell'; data: any }> {
    const events: Array<{ type: 'buy' | 'sell'; data: any }> = [];
    
    if (!this.programType || !this.coder) {
      return events;
    }

    for (const log of logs) {
      if (log.startsWith('Program data: ')) {
        const base64Data = log.replace('Program data: ', '');
        
        if (this.programType === 'pump') {
          const eventData = this.decodeEvent(base64Data, 'TradeEvent');
          if (eventData) {
            events.push({
              type: eventData.is_buy ? 'buy' : 'sell',
              data: eventData
            });
          }
        } else if (this.programType === 'pump_amm') {
          const buyEvent = this.decodeEvent(base64Data, 'BuyEvent');
          if (buyEvent) {
            events.push({ type: 'buy', data: buyEvent });
          } else {
            const sellEvent = this.decodeEvent(base64Data, 'SellEvent');
            if (sellEvent) {
              events.push({ type: 'sell', data: sellEvent });
            }
          }
        }
      }
    }
    
    return events;
  }

  private decodeAccountData(accountData: Buffer): any | null {
    if (!this.coder) {
      return null;
    }

    try {
      if (accountData.length < 8) {
        return null;
      }

      const accountsCoder = this.coder.accounts as any;
      
      if (accountsCoder && accountsCoder.layouts && accountsCoder.layouts['BondingCurve']) {
        const accountLayout = accountsCoder.layouts['BondingCurve'];
        const decoded = accountLayout.decode(accountData);
        if (decoded !== null && decoded !== undefined) {
          return decoded;
        }
      }
      
      if (accountsCoder && typeof accountsCoder.decode === 'function') {
        try {
          const decoded = accountsCoder.decode(accountData);
          if (decoded && decoded.data) {
            return decoded.data;
          }
        } catch (decodeError) {
        }
      }
      
      return null;
    } catch (error) {
      console.error('Failed to decode account data:', error);
      return null;
    }
  }

  async subscribe(): Promise<void> {
    if (this.status.subscribed) {
      throw new Error('Already subscribed');
    }

    try {
      await this.determineProgramType();
      
      if (!this.programType || !this.coder || !this.programId) {
        throw new Error('Failed to determine program type');
      }

      this.accountListenerId = this.connection.onAccountChange(
        this.bondingCurve,
        (accountInfo, context) => {
          if (accountInfo.data && Buffer.isBuffer(accountInfo.data)) {
            const decodedAccountData = this.decodeAccountData(accountInfo.data);
            if (decodedAccountData) {
              const lamports = accountInfo.lamports || 0;
              const sol = lamports / 1_000_000_000;
              
              this.latestAccountData = {
                data: decodedAccountData,
                lamports: lamports,
                sol: sol,
                slot: context.slot
              };
            }
          }
        },
        'finalized'
      );

      this.logsListenerId = this.connection.onLogs(
        this.programId,
        (logs, context) => {
          const events = this.parseLogsForEvents(logs.logs);
          
          for (const event of events) {
            this.status.eventCount++;
            this.status.lastEventTime = new Date();
            
            let solAmountLamports = 0;
            if (this.programType === 'pump') {
              solAmountLamports = event.data?.sol_amount || 0;
            } else if (this.programType === 'pump_amm') {
              if (event.type === 'buy') {
                solAmountLamports = event.data?.quote_amount_in || 0;
              } else {
                solAmountLamports = event.data?.quote_amount_out || 0;
              }
            }
            const solAmount = solAmountLamports / 1_000_000_000;

            // Extract timestamp from event data or use current time
            let timestamp = Math.floor(Date.now() / 1000); // Default to current time in seconds
            if (event.data?.timestamp) {
              // If timestamp is in nanoseconds (i64), convert to seconds
              const ts = Number(event.data.timestamp);
              timestamp = ts > 1e12 ? Math.floor(ts / 1e9) : ts;
            }

            const transactionEvent: TransactionEvent = {
              type: event.type,
              amount: solAmount,
              signature: logs.signature,
              timestamp: timestamp
            };

            this.notifyCallbacks(transactionEvent);
          }
        },
        'finalized'
      );

      this.status.subscribed = true;
      this.status.listenerId = this.logsListenerId;
      this.subscriptionId = this.logsListenerId;
    } catch (error) {
      this.status.error = error;
      console.error('Error subscribing to transactions:', error);
      if (error instanceof Error) {
        console.error('Error details:', error.message);
        console.error('Stack:', error.stack);
      }
      throw error;
    }
  }

  unsubscribe(): void {
    if (this.subscriptionId !== null) {
      try {
        this.connection.removeAccountChangeListener(this.subscriptionId);
      } catch (error) {
        console.error('Error removing account change listener:', error);
      }
      this.subscriptionId = null;
      this.status.subscribed = false;
      this.status.listenerId = null;
    }
  }

  onTransaction(callback: TransactionCallback): () => void {
    this.callbacks.add(callback);
    
    return () => {
      this.callbacks.delete(callback);
    };
  }

  private notifyCallbacks(event: TransactionEvent): void {
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

