import { Connection, PublicKey, AccountInfo } from '@solana/web3.js';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import pumpIdl from '../../config/idl/pump/idl.json';
import pumpAmmIdl from '../../config/idl/pump_amm/idl.json';

// Program IDs
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

// Event discriminators from IDLs
const TRADE_EVENT_DISCRIMINATOR = [189, 219, 127, 211, 78, 230, 97, 238]; // TradeEvent from pump
const BUY_EVENT_DISCRIMINATOR = [103, 244, 82, 31, 44, 245, 119, 119]; // BuyEvent from pump_amm
const SELL_EVENT_DISCRIMINATOR = [62, 47, 55, 10, 165, 3, 220, 42]; // SellEvent from pump_amm

export interface TransactionEvent {
  type: 'buy' | 'sell';
  bondingCurve: string;
  data: any;
  signature: string;
  slot: number;
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

/**
 * TransactionSubscription handles subscribing to bonding curve account changes
 * and notifying callbacks when buy/sell transactions occur
 */
export class TransactionSubscription {
  private connection: Connection;
  private bondingCurve: PublicKey;
  private subscriptionId: number | null = null;
  private status: TransactionSubscriptionStatus;
  private callbacks: Set<TransactionCallback> = new Set();
  private programId: PublicKey | null = null;
  private programType: 'pump' | 'pump_amm' | null = null;
  private coder: BorshCoder | null = null;

  constructor(bondingCurve: string | PublicKey, rpcUrl?: string) {
    const url = rpcUrl || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(url, 'processed');
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

  /**
   * Determine program type and IDL from bonding curve account owner
   */
  private async determineProgramType(): Promise<void> {
    try {
      const accountInfo = await this.connection.getAccountInfo(this.bondingCurve);
      
      if (!accountInfo) {
        throw new Error(`Bonding curve account not found: ${this.bondingCurve.toString()}`);
      }

      this.programId = accountInfo.owner;
      
      // Determine which program owns this account
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
      
      console.log(`✓ Determined program type: ${this.programType} (${this.programId.toString()})`);
    } catch (error) {
      console.error('Error determining program type:', error);
      throw error;
    }
  }

  /**
   * Helper function to decode event from log data
   */
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
      
      // Check discriminator matches expected event
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
      
      // Try to decode using the coder
      try {
        const eventsCoder = this.coder.events as any;
        
        // Try using events layouts
        if (eventsCoder && eventsCoder.layouts && eventsCoder.layouts[eventType]) {
          const eventLayout = eventsCoder.layouts[eventType];
          const decoded = eventLayout.decode(eventData);
          if (decoded !== null && decoded !== undefined) {
            return decoded;
          }
        }
        
        // Try using decode method with full buffer
        if (eventsCoder && typeof eventsCoder.decode === 'function') {
          try {
            const decoded = eventsCoder.decode(dataBuffer);
            if (decoded && decoded.data) {
              return decoded.data;
            }
          } catch (decodeError) {
            // Continue to next method
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

  /**
   * Parse logs for buy/sell events
   */
  private parseLogsForEvents(logs: string[]): Array<{ type: 'buy' | 'sell'; data: any }> {
    const events: Array<{ type: 'buy' | 'sell'; data: any }> = [];
    
    if (!this.programType || !this.coder) {
      return events;
    }

    for (const log of logs) {
      // Anchor events are logged as "Program data: <base64>"
      if (log.startsWith('Program data: ')) {
        const base64Data = log.replace('Program data: ', '');
        
        if (this.programType === 'pump') {
          // Pump uses TradeEvent with is_buy field
          const eventData = this.decodeEvent(base64Data, 'TradeEvent');
          if (eventData) {
            events.push({
              type: eventData.is_buy ? 'buy' : 'sell',
              data: eventData
            });
          }
        } else if (this.programType === 'pump_amm') {
          // Pump AMM uses separate BuyEvent and SellEvent
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

  /**
   * Subscribe to bonding curve account changes using accountSubscribe
   * We'll use program logs and filter by checking if bonding curve is involved
   */
  async subscribe(): Promise<void> {
    if (this.status.subscribed) {
      throw new Error('Already subscribed');
    }

    console.log(`Subscribing to transactions for bonding curve: ${this.bondingCurve.toString()}`);
    
    try {
      // First, determine which program owns this account
      await this.determineProgramType();
      
      if (!this.programType || !this.coder || !this.programId) {
        throw new Error('Failed to determine program type');
      }

      // Also subscribe to account changes to track when bonding curve is modified
      // This ensures we catch all transactions that modify the account
      const accountListenerId = this.connection.onAccountChange(
        this.bondingCurve,
        async (accountInfo, context) => {
          // Account changed - fetch the most recent transaction for this account
          try {
            const signatures = await this.connection.getSignaturesForAddress(
              this.bondingCurve,
              { limit: 1 }
            );

            if (signatures.length === 0) {
              return;
            }

            const signature = signatures[0].signature;
            
            // Fetch the full transaction
            const tx = await this.connection.getTransaction(signature, {
              maxSupportedTransactionVersion: 0
            });

            if (!tx || !tx.meta || tx.meta.err || !tx.meta.logMessages) {
              return;
            }

            // Parse logs for buy/sell events
            const events = this.parseLogsForEvents(tx.meta.logMessages);
            
            for (const event of events) {
              this.status.eventCount++;
              this.status.lastEventTime = new Date();
              
              console.log(`\n✓ ${event.type.toUpperCase()} event received:`, {
                signature: signature,
                slot: context.slot,
                bondingCurve: this.bondingCurve.toString()
              });

              // Create the event object
              const transactionEvent: TransactionEvent = {
                type: event.type,
                bondingCurve: this.bondingCurve.toString(),
                data: event.data,
                signature: signature,
                slot: context.slot
              };

              // Notify all callbacks
              this.notifyCallbacks(transactionEvent);
            }
          } catch (error) {
            console.error('Error processing account change:', error);
          }
        },
        'processed'
      );

      this.status.subscribed = true;
      this.status.listenerId = accountListenerId;
      this.subscriptionId = accountListenerId;
      console.log(`✓ Subscribed to account changes with listener ID: ${accountListenerId}`);
      console.log(`✓ Monitoring bonding curve: ${this.bondingCurve.toString()}`);
      console.log(`✓ Program: ${this.programType} (${this.programId.toString()})`);
      console.log('Waiting for buy/sell transactions...\n');
    } catch (error) {
      this.status.error = error;
      console.error('✗ Error subscribing to transactions:', error);
      if (error instanceof Error) {
        console.error('Error details:', error.message);
        console.error('Stack:', error.stack);
      }
      throw error;
    }
  }

  /**
   * Unsubscribe from account changes
   */
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

  /**
   * Add a callback to be notified when transactions occur
   */
  onTransaction(callback: TransactionCallback): () => void {
    this.callbacks.add(callback);
    
    // Return unsubscribe function
    return () => {
      this.callbacks.delete(callback);
    };
  }

  /**
   * Notify all callbacks of a transaction event
   */
  private notifyCallbacks(event: TransactionEvent): void {
    this.callbacks.forEach((callback) => {
      try {
        callback(event);
      } catch (error) {
        console.error('Error in transaction callback:', error);
      }
    });
  }

  /**
   * Get current subscription status
   */
  getStatus(): TransactionSubscriptionStatus {
    return { ...this.status };
  }

  /**
   * Get the connection instance
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Get the bonding curve address
   */
  getBondingCurve(): PublicKey {
    return this.bondingCurve;
  }
}

