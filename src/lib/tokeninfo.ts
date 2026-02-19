import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import pumpIdl from '../../config/idl/pump/idl.json';
import pumpAmmIdl from '../../config/idl/pump_amm/idl.json';

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

// Cache for SOL price to avoid excessive API calls
let solPriceCache: { price: number; timestamp: number } | null = null;
const SOL_PRICE_CACHE_TTL = 60000; // 1 minute cache

async function getSolPriceUsd(): Promise<number | null> {
	// Check cache first
	if (solPriceCache && Date.now() - solPriceCache.timestamp < SOL_PRICE_CACHE_TTL) {
		return solPriceCache.price;
	}

	try {
		const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
			headers: {
				'Accept': 'application/json'
			}
		});

		if (!response.ok) {
			console.warn('Failed to fetch SOL price from CoinGecko:', response.status);
			return null;
		}

		const data = await response.json() as { solana?: { usd?: number } };
		const price = data.solana?.usd;

		if (price && price > 0) {
			solPriceCache = {
				price: price,
				timestamp: Date.now()
			};
			return price;
		}

		return null;
	} catch (error) {
		console.warn('Error fetching SOL price:', error);
		return null;
	}
}


export interface TokenInfo {
  mint: string;
  bondingCurve: string;
  migrated: boolean;
  creator: string;
  isMayhemMode: boolean;
  price?: number;
  marketcap?: number;
  priceUsd?: number;
  marketcapUsd?: number;
  metadata?: {
    name?: string;
    symbol?: string;
    uri?: string;
    decimals?: number;
    supply?: string;
  };
}

export interface BondingCurveInfo {
  bondingCurve: string;
}

export interface TopHolder {
  wallet: string;
  percentage: number;
  isBondingCurve?: boolean;
}

export async function deriveBondingCurve(mint: string | PublicKey): Promise<PublicKey> {
  const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return bondingCurve;
}

export async function getBondingCurveFromMint(
  mint: string | PublicKey,
  rpcUrl?: string
): Promise<BondingCurveInfo> {
  let mintPubkey: PublicKey;
  try {
    mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
  } catch (error) {
    throw new Error(`Invalid mint address: ${mint}. ${error instanceof Error ? error.message : 'Invalid public key format'}`);
  }

  const bondingCurve = await deriveBondingCurve(mintPubkey);

  return {
    bondingCurve: bondingCurve.toString()
  };
}

async function getTokenMetadata(
  mint: PublicKey,
  connection: Connection
): Promise<{ name?: string; symbol?: string; uri?: string; decimals?: number; supply?: string } | undefined> {
  try {
    const accountInfo = await connection.getParsedAccountInfo(mint, {
      commitment: 'confirmed'
    });

    if (!accountInfo.value) {
      return undefined;
    }

    const parsed = accountInfo.value.data;
    
    if (parsed && typeof parsed === 'object' && 'parsed' in parsed) {
      const parsedData = (parsed as any).parsed;
      
      if (parsedData && parsedData.type === 'mint' && parsedData.info) {
        const info = parsedData.info;
        const metadata: { name?: string; symbol?: string; uri?: string; decimals?: number; supply?: string } = {
          decimals: info.decimals,
          supply: info.supply?.toString()
        };

        if (info.extensions && Array.isArray(info.extensions)) {
          for (const ext of info.extensions) {
            if (ext.extension === 'tokenMetadata' && ext.state) {
              metadata.name = ext.state.name;
              metadata.symbol = ext.state.symbol;
              metadata.uri = ext.state.uri;
              break;
            }
          }
        }

        return metadata;
      }
    }

    return undefined;
  } catch (error) {
    try {
      const rawAccount = await connection.getAccountInfo(mint);
      if (rawAccount) {
        return undefined;
      }
    } catch (rawError) {
    }
    return undefined;
  }
}

export async function getTokenInfo(
  mint: string | PublicKey,
  rpcUrl?: string
): Promise<TokenInfo> {
  const url = rpcUrl || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(url, 'confirmed');

  let mintPubkey: PublicKey;
  try {
    mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
  } catch (error) {
    throw new Error(`Invalid mint address: ${mint}. ${error instanceof Error ? error.message : 'Invalid public key format'}`);
  }

  const bondingCurve = await deriveBondingCurve(mintPubkey);
  const [accountInfo, metadata] = await Promise.all([
    connection.getAccountInfo(bondingCurve),
    getTokenMetadata(mintPubkey, connection)
  ]);
  
  if (!accountInfo) {
    throw new Error(`Bonding curve not found for mint: ${mintPubkey.toString()}. The bonding curve account does not exist. This may mean: 1) The token was never created on pump.fun, 2) The bonding curve was closed/migrated, or 3) The mint address is incorrect.`);
  }

  const programId = accountInfo.owner;
  
  if (!programId.equals(PUMP_PROGRAM_ID) && !programId.equals(PUMP_AMM_PROGRAM_ID)) {
    throw new Error(`Bonding curve account is owned by unknown program: ${programId.toString()}. Expected pump (${PUMP_PROGRAM_ID.toString()}) or pump_amm (${PUMP_AMM_PROGRAM_ID.toString()}) program.`);
  }
  
  let coder: BorshCoder;
  let migrated = false;
  
  if (programId.equals(PUMP_AMM_PROGRAM_ID)) {
    migrated = true;
    coder = new BorshCoder(pumpAmmIdl as Idl);
  } else {
    coder = new BorshCoder(pumpIdl as Idl);
  }

  const decoded = decodeBondingCurve(accountInfo.data, coder);
  
  if (programId.equals(PUMP_PROGRAM_ID)) {
    if (decoded && decoded.complete === true) {
      migrated = true;
    } else {
      migrated = false;
    }
  }
  
  if (!decoded) {
    if (metadata) {
      return {
        mint: mintPubkey.toString(),
        bondingCurve: bondingCurve.toString(),
        migrated: migrated,
        creator: '',
        isMayhemMode: false,
        metadata: metadata
      };
    }
    
    const programName = programId.equals(PUMP_PROGRAM_ID) ? 'pump' : 'pump_amm';
    throw new Error(`Failed to decode bonding curve data for mint: ${mintPubkey.toString()}. Account owner: ${programName} (${programId.toString()}). Account data length: ${accountInfo.data.length} bytes. The account may not be a valid BondingCurve account.`);
  }

  // Calculate price and marketcap
  let price: number | undefined;
  let marketcap: number | undefined;
  let priceUsd: number | undefined;
  let marketcapUsd: number | undefined;

  if (decoded.virtual_sol_reserves !== undefined && decoded.virtual_token_reserves !== undefined) {
    const virtualSolReserves = typeof decoded.virtual_sol_reserves === 'bigint' 
      ? Number(decoded.virtual_sol_reserves) 
      : decoded.virtual_sol_reserves;
    const virtualTokenReserves = typeof decoded.virtual_token_reserves === 'bigint' 
      ? Number(decoded.virtual_token_reserves) 
      : decoded.virtual_token_reserves;

    if (virtualTokenReserves > 0) {
      // price = virtual_sol_reserves / virtual_token_reserves (lamports per token base unit)
      price = virtualSolReserves / virtualTokenReserves;
      
      // Convert lamports to SOL per full token (accounting for 6 decimals)
      // price is lamports per token base unit, tokens have 6 decimals (1e6 base units per token)
      // So: SOL per full token = (price / 1e9) * 1e6 = price / 1e3
      const priceInSol = price / 1e3; // SOL per full token
      
      // marketcap = priceInSol × 1,000,000,000 (total supply in SOL)
      marketcap = priceInSol * 1_000_000_000;

      // Convert SOL amounts to USD
      const solPriceUsd = await getSolPriceUsd();
      if (solPriceUsd !== null && solPriceUsd > 0) {
        priceUsd = priceInSol * solPriceUsd;
        
        // marketcapUsd = priceUsd × 1,000,000,000 (total supply)
        marketcapUsd = priceUsd * 1_000_000_000;
      }
    }
  }

  return {
    mint: mintPubkey.toString(),
    bondingCurve: bondingCurve.toString(),
    migrated: migrated,
    creator: decoded.creator?.toString() || '',
    isMayhemMode: decoded.is_mayhem_mode || false,
    price: price,
    marketcap: marketcap,
    priceUsd: priceUsd,
    marketcapUsd: marketcapUsd,
    metadata: metadata
  };
}

function decodeBondingCurve(accountData: Buffer, coder: BorshCoder): any | null {
  if (!coder) {
    return null;
  }

  try {
    if (accountData.length < 8) {
      return null;
    }

    const accountsCoder = coder.accounts as any;
    
    if (accountsCoder && accountsCoder.layouts && accountsCoder.layouts['BondingCurve']) {
      try {
        const accountLayout = accountsCoder.layouts['BondingCurve'];
        const decoded = accountLayout.decode(accountData);
        if (decoded !== null && decoded !== undefined) {
          if (decoded.complete !== undefined || decoded.creator !== undefined || decoded.virtual_token_reserves !== undefined) {
            return decoded;
          }
        }
      } catch (layoutError) {
        if (accountData.length > 8) {
          try {
            const dataWithoutDiscriminator = accountData.slice(8);
            const accountLayout = accountsCoder.layouts['BondingCurve'];
            const decoded = accountLayout.decode(dataWithoutDiscriminator);
            if (decoded !== null && decoded !== undefined) {
              if (decoded.complete !== undefined || decoded.creator !== undefined || decoded.virtual_token_reserves !== undefined) {
                return decoded;
              }
            }
          } catch (skipDiscriminatorError) {
          }
        }
      }
    }
    
    if (accountsCoder && typeof accountsCoder.decode === 'function') {
      try {
        const decoded = accountsCoder.decode(accountData);
        if (decoded) {
          if (decoded.name === 'BondingCurve' && decoded.data) {
            return decoded.data;
          }
          if (decoded.data && (decoded.data.complete !== undefined || decoded.data.creator !== undefined)) {
            return decoded.data;
          }
          if (decoded.complete !== undefined || decoded.creator !== undefined) {
            return decoded;
          }
        }
      } catch (decodeError) {
      }
    }
    
    if (accountData.length >= 82) {
      try {
        let offset = 8;
        
        const virtualTokenReserves = accountData.readBigUInt64LE(offset);
        offset += 8;
        
        const virtualSolReserves = accountData.readBigUInt64LE(offset);
        offset += 8;
        
        const realTokenReserves = accountData.readBigUInt64LE(offset);
        offset += 8;
        
        const realSolReserves = accountData.readBigUInt64LE(offset);
        offset += 8;
        
        const tokenTotalSupply = accountData.readBigUInt64LE(offset);
        offset += 8;
        
        const complete = accountData[offset] !== 0;
        offset += 1;
        
        const creatorBytes = accountData.slice(offset, offset + 32);
        const creator = new PublicKey(creatorBytes);
        offset += 32;
        
        const isMayhemMode = offset < accountData.length ? accountData[offset] !== 0 : false;
        
        return {
          virtual_token_reserves: virtualTokenReserves,
          virtual_sol_reserves: virtualSolReserves,
          real_token_reserves: realTokenReserves,
          real_sol_reserves: realSolReserves,
          token_total_supply: tokenTotalSupply,
          complete: complete,
          creator: creator,
          is_mayhem_mode: isMayhemMode
        };
      } catch (manualError) {
      }
    }
    
    return null;
  } catch (error) {
    console.error('Failed to decode bonding curve account data:', error);
    return null;
  }
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 5,
  initialDelay: number = 500
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      
      // Check if it's a 429 error
      const isRateLimit = error?.message?.includes('429') || 
                         error?.message?.includes('Too many requests') ||
                         error?.code === 429;
      
      if (!isRateLimit || attempt === maxRetries - 1) {
        throw error;
      }
      
      // Exponential backoff: 500ms, 1000ms, 2000ms, 4000ms, 8000ms
      const delay = initialDelay * Math.pow(2, attempt);
      console.log(`Server responded with 429 Too Many Requests.  Retrying after ${delay}ms delay...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError || new Error('Max retries exceeded');
}

export async function getTopHolders(
  mint: string | PublicKey,
  rpcUrl?: string
): Promise<TopHolder[]> {
  const url = rpcUrl || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(url, 'confirmed');

  let mintPubkey: PublicKey;
  try {
    mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
  } catch (error) {
    throw new Error(`Invalid mint address: ${mint}. ${error instanceof Error ? error.message : 'Invalid public key format'}`);
  }

  const bondingCurve = await deriveBondingCurve(mintPubkey);
  
  // Retry RPC calls with exponential backoff
  const [largestAccounts, mintInfo] = await Promise.all([
    retryWithBackoff(() => connection.getTokenLargestAccounts(mintPubkey)),
    retryWithBackoff(() => connection.getParsedAccountInfo(mintPubkey))
  ]);

  if (!mintInfo.value) {
    throw new Error(`Mint account not found: ${mintPubkey.toString()}`);
  }

  const parsedMint = (mintInfo.value.data as any).parsed;
  if (!parsedMint || parsedMint.type !== 'mint') {
    throw new Error(`Invalid mint account: ${mintPubkey.toString()}`);
  }

  const supply = BigInt(parsedMint.info.supply || '0');
  if (supply === 0n) {
    return [];
  }

  const tokenAccountPubkeys = largestAccounts.value.map(acc => new PublicKey(acc.address));
  
  // Retry getMultipleAccountsInfo with exponential backoff
  const accountInfos = await retryWithBackoff(() => 
    connection.getMultipleAccountsInfo(tokenAccountPubkeys)
  );
  
  const holders: TopHolder[] = [];

  for (let i = 0; i < largestAccounts.value.length; i++) {
    try {
      const account = largestAccounts.value[i];
      const accountInfo = accountInfos[i];
      
      if (!accountInfo) {
        continue;
      }

      const tokenAccountProgramOwner = accountInfo.owner;
      const isBondingCurve = tokenAccountProgramOwner.equals(PUMP_PROGRAM_ID) ||
                            tokenAccountProgramOwner.equals(PUMP_AMM_PROGRAM_ID);

      let walletAddress: string;
      if (isBondingCurve) {
        walletAddress = bondingCurve.toString();
      } else {
        const ownerOffset = 32;
        if (accountInfo.data.length < ownerOffset + 32) {
          continue;
        }
        const ownerBytes = accountInfo.data.slice(ownerOffset, ownerOffset + 32);
        walletAddress = new PublicKey(ownerBytes).toString();
      }

      const rawAmount = BigInt(account.amount || '0');
      const percentage = Number((rawAmount * 10000n) / supply) / 100;

      holders.push({
        wallet: walletAddress,
        percentage: Math.round(percentage * 100) / 100,
        isBondingCurve: isBondingCurve || undefined
      });
    } catch (error) {
      console.error(`Error processing holder ${largestAccounts.value[i].address}:`, error);
      continue;
    }
  }

  return holders;
}

