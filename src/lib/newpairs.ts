import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import idl from '../../config/idl/pump/idl.json';

const PUMPFUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const CREATE_EVENT_DISCRIMINATOR = [27, 114, 169, 77, 222, 235, 99, 118];

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

export interface NewPairEvent {
  type: 'newPair';
  instructionType: 'create' | 'create_v2';
  data: {
    name: string;
    symbol: string;
    uri: string;
    mint: string;
    bondingCurve: string;
    user: string;
    creator: string;
    timestamp: string;
    virtualTokenReserves: string;
    virtualSolReserves: string;
    realTokenReserves: string;
    tokenTotalSupply: string;
    tokenProgram: string;
    isMayhemMode: boolean;
  };
  signature: string;
  slot: number;
}

export interface SubscriptionStatus {
  subscribed: boolean;
  listenerId: number | null;
  error: any;
  lastEventTime: Date | null;
  eventCount: number;
}

export type NewPairCallback = (event: NewPairEvent) => void;

export class NewPairsSubscription {
  private connection: Connection;
  private coder: BorshCoder;
  private subscriptionId: number | null = null;
  private status: SubscriptionStatus;
  private callbacks: Set<NewPairCallback> = new Set();

  constructor(rpcUrl?: string) {
    const url = rpcUrl || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(url, 'processed');
    this.coder = new BorshCoder(idl as Idl);
    this.status = {
      subscribed: false,
      listenerId: null,
      error: null,
      lastEventTime: null,
      eventCount: 0
    };
  }

  private getInstructionType(tokenProgram: PublicKey | string | null | undefined): 'create' | 'create_v2' {
    if (!tokenProgram) {
      return 'create';
    }
    
    try {
      const tokenProgramPubkey = typeof tokenProgram === 'string' 
        ? (tokenProgram.trim() ? new PublicKey(tokenProgram) : null)
        : tokenProgram;
      
      if (!tokenProgramPubkey) {
        return 'create';
      }
      
      if (tokenProgramPubkey.equals(TOKEN_2022_PROGRAM)) {
        return 'create_v2';
      }
      return 'create';
    } catch (error) {
      return 'create';
    }
  }

  private decodeEvent(logData: string): any | null {
    try {
      const dataBuffer = Buffer.from(logData, 'base64');
      
      if (dataBuffer.length < 8) {
        return null;
      }
      
      const discriminator = Array.from(dataBuffer.slice(0, 8));
      
      const isCreateEvent = discriminator.every((byte, index) => byte === CREATE_EVENT_DISCRIMINATOR[index]);
      
      if (!isCreateEvent) {
        return null;
      }
      
      const eventData = dataBuffer.slice(8);
      
      try {
        const eventsCoder = this.coder.events as any;
        
        if (eventsCoder && eventsCoder.layouts && eventsCoder.layouts['CreateEvent']) {
          const eventLayout = eventsCoder.layouts['CreateEvent'];
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
        console.error('Failed to decode CreateEvent:', error);
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  async subscribe(): Promise<void> {
    if (this.status.subscribed) {
      throw new Error('Already subscribed');
    }

    try {
      await this.connection.getSlot();
      
      const listenerId = this.connection.onLogs(
        PUMPFUN_PROGRAM_ID,
        (logs, context) => {
          for (const log of logs.logs) {
            if (log.startsWith('Program data: ')) {
              const base64Data = log.replace('Program data: ', '');
              const eventData = this.decodeEvent(base64Data);
              
              if (eventData) {
                this.status.eventCount++;
                this.status.lastEventTime = new Date();
                
                const tokenProgram = eventData.tokenProgram;
                const instructionType = this.getInstructionType(tokenProgram);

                const newPairEvent: NewPairEvent = {
                  type: 'newPair',
                  instructionType,
                  data: {
                    name: eventData.name,
                    symbol: eventData.symbol,
                    uri: eventData.uri,
                    mint: eventData.mint?.toString() || '',
                    bondingCurve: eventData.bondingCurve?.toString() || '',
                    user: eventData.user?.toString() || '',
                    creator: eventData.creator?.toString() || '',
                    timestamp: eventData.timestamp?.toString() || '0',
                    virtualTokenReserves: eventData.virtualTokenReserves?.toString() || '0',
                    virtualSolReserves: eventData.virtualSolReserves?.toString() || '0',
                    realTokenReserves: eventData.realTokenReserves?.toString() || '0',
                    tokenTotalSupply: eventData.tokenTotalSupply?.toString() || '0',
                    tokenProgram: tokenProgram?.toString() || '',
                    isMayhemMode: eventData.isMayhemMode || false
                  },
                  signature: logs.signature,
                  slot: context.slot
                };

                this.notifyCallbacks(newPairEvent);
              }
            }
          }
        },
        'processed'
      );

      this.status.subscribed = true;
      this.status.listenerId = listenerId;
      this.subscriptionId = listenerId;
    } catch (error) {
      this.status.error = error;
      console.error('Error subscribing to Pumpfun program:', error);
      if (error instanceof Error) {
        console.error('Error details:', error.message);
        console.error('Stack:', error.stack);
      }
      throw error;
    }
  }

  unsubscribe(): void {
    if (this.subscriptionId !== null) {
      this.connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
      this.status.subscribed = false;
      this.status.listenerId = null;
    }
  }

  onNewPair(callback: NewPairCallback): () => void {
    this.callbacks.add(callback);
    
    return () => {
      this.callbacks.delete(callback);
    };
  }

  private notifyCallbacks(event: NewPairEvent): void {
    this.callbacks.forEach((callback) => {
      try {
        callback(event);
      } catch (error) {
        console.error('Error in new pair callback:', error);
      }
    });
  }

  getStatus(): SubscriptionStatus {
    return { ...this.status };
  }

  getConnection(): Connection {
    return this.connection;
  }

  getProgramId(): PublicKey {
    return PUMPFUN_PROGRAM_ID;
  }
}

