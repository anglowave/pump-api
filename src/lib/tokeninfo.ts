import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, getAccount } from '@solana/spl-token';
import pumpIdl from '../../config/idl/pump/idl.json';
import pumpAmmIdl from '../../config/idl/pump_amm/idl.json';

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

let solPriceCache: { price: number; timestamp: number } | null = null;
const SOL_PRICE_CACHE_TTL = 60000;

async function getSolPriceUsd(): Promise<number | null> {
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
    connection.getAccountInfo(bondingCurve).catch(() => null),
    getTokenMetadata(mintPubkey, connection)
  ]);
  
  let coder: BorshCoder;
  let migrated = false;
  let decoded: any = null;
  let creator: string | null = null;
  
  if (!accountInfo) {
    migrated = true;
  } else {
    const programId = accountInfo.owner;
    
    if (!programId.equals(PUMP_PROGRAM_ID) && !programId.equals(PUMP_AMM_PROGRAM_ID)) {
      throw new Error(`Bonding curve account is owned by unknown program: ${programId.toString()}. Expected pump (${PUMP_PROGRAM_ID.toString()}) or pump_amm (${PUMP_AMM_PROGRAM_ID.toString()}) program.`);
    }
    
    if (programId.equals(PUMP_AMM_PROGRAM_ID)) {
      migrated = true;
      coder = new BorshCoder(pumpAmmIdl as Idl);
    } else {
      coder = new BorshCoder(pumpIdl as Idl);
    }

    decoded = decodeBondingCurve(accountInfo.data, coder);
    
    if (programId.equals(PUMP_PROGRAM_ID)) {
      if (decoded && decoded.complete === true) {
        migrated = true;
      } else {
        migrated = false;
      }
    }
    
    if (decoded && decoded.creator) {
      creator = typeof decoded.creator === 'object' && 'toBase58' in decoded.creator 
        ? decoded.creator.toBase58() 
        : new PublicKey(decoded.creator as Uint8Array).toString();
    }
  }
  
  if (!decoded && !migrated) {
    if (metadata) {
      return {
        mint: mintPubkey.toString(),
        bondingCurve: bondingCurve.toString(),
        migrated: false,
        creator: '',
        isMayhemMode: false,
        metadata: metadata
      };
    }
    
    throw new Error(`Failed to decode bonding curve data for mint: ${mintPubkey.toString()}. The bonding curve account may not exist or may not be a valid BondingCurve account.`);
  }

  let price: number | undefined;
  let marketcap: number | undefined;
  let priceUsd: number | undefined;
  let marketcapUsd: number | undefined;

  if (migrated) {
    try {
      let poolAccountInfo: { pubkey: PublicKey; account: { data: Buffer } } | null = null;
      
      try {
        const [poolAuthority] = PublicKey.findProgramAddressSync(
          [Buffer.from('pool-authority'), mintPubkey.toBuffer()],
          PUMP_PROGRAM_ID
        );
        
        const indexBuffer = Buffer.allocUnsafe(2);
        indexBuffer.writeUInt16LE(0, 0);
        const [pool] = PublicKey.findProgramAddressSync(
          [
            Buffer.from('pool'),
            indexBuffer,
            poolAuthority.toBuffer(),
            mintPubkey.toBuffer(),
            WSOL_MINT.toBuffer()
          ],
          PUMP_AMM_PROGRAM_ID
        );
        
        const accountInfo = await connection.getAccountInfo(pool).catch(() => null);
        if (accountInfo) {
          poolAccountInfo = { pubkey: pool, account: accountInfo };
        }
      } catch (poolAuthError) {
      }
      
      if (!poolAccountInfo) {
        try {
          const poolAccounts = await connection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, {
            filters: [
              {
                dataSize: 200
              }
            ]
          });

          const poolCoder = new BorshCoder(pumpAmmIdl as Idl);
          for (const { pubkey, account } of poolAccounts) {
            try {
              const decoded = poolCoder.accounts.decode('Pool', account.data);
              if (decoded && decoded.base_mint && new PublicKey(decoded.base_mint).equals(mintPubkey)) {
                poolAccountInfo = { pubkey, account };
                break;
              }
            } catch {
              continue;
            }
          }
        } catch (searchError) {
        }
      }
      
      if (!poolAccountInfo && creator) {
        try {
          const indexBuffer = Buffer.allocUnsafe(2);
          indexBuffer.writeUInt16LE(0, 0);
          const [pool] = PublicKey.findProgramAddressSync(
            [
              Buffer.from('pool'),
              indexBuffer,
              new PublicKey(creator).toBuffer(),
              mintPubkey.toBuffer(),
              WSOL_MINT.toBuffer()
            ],
            PUMP_AMM_PROGRAM_ID
          );
          const accountInfo = await connection.getAccountInfo(pool).catch(() => null);
          if (accountInfo) {
            poolAccountInfo = { pubkey: pool, account: accountInfo };
          }
        } catch {
        }
      }
      
      if (!poolAccountInfo) {
        console.warn(`Pool account not found for migrated coin ${mintPubkey.toString()}`);
      }
      
      if (poolAccountInfo) {
        try {
          const poolCoder = new BorshCoder(pumpAmmIdl as Idl);
          const poolDecoded = poolCoder.accounts.decode('Pool', poolAccountInfo.account.data);
          
          if (poolDecoded && poolDecoded.pool_base_token_account && poolDecoded.pool_quote_token_account) {
            const poolBaseTokenAccount = new PublicKey(poolDecoded.pool_base_token_account);
            const poolQuoteTokenAccount = new PublicKey(poolDecoded.pool_quote_token_account);

            const [baseAccountInfo, quoteAccountInfo] = await Promise.all([
              connection.getParsedAccountInfo(poolBaseTokenAccount).catch(() => null),
              connection.getParsedAccountInfo(poolQuoteTokenAccount).catch(() => null)
            ]);

            if (baseAccountInfo?.value && quoteAccountInfo?.value) {
              const baseParsed = (baseAccountInfo.value.data as any).parsed?.info;
              const quoteParsed = (quoteAccountInfo.value.data as any).parsed?.info;
              
              if (baseParsed?.tokenAmount && quoteParsed?.tokenAmount) {
                const baseBalance = BigInt(baseParsed.tokenAmount.amount || '0');
                const quoteBalance = BigInt(quoteParsed.tokenAmount.amount || '0');

                if (baseBalance > 0n && quoteBalance > 0n) {
                  price = Number(quoteBalance) / Number(baseBalance);
                  
                  const priceInSol = price / 1e3;
                  
                  marketcap = priceInSol * 1_000_000_000;

                  const solPriceUsd = await getSolPriceUsd();
                  if (solPriceUsd !== null && solPriceUsd > 0) {
                    priceUsd = priceInSol * solPriceUsd;
                    marketcapUsd = priceUsd * 1_000_000_000;
                  }
                }
              }
            } else {
              try {
                const [baseAccount, quoteAccount] = await Promise.all([
                  getAccount(connection, poolBaseTokenAccount, 'confirmed', TOKEN_PROGRAM_ID).catch(() => null),
                  getAccount(connection, poolQuoteTokenAccount, 'confirmed', TOKEN_PROGRAM_ID).catch(() => null)
                ]);

                if (baseAccount && quoteAccount) {
                  const baseBalance = baseAccount.amount;
                  const quoteBalance = quoteAccount.amount;

                  if (baseBalance > 0n && quoteBalance > 0n) {
                    price = Number(quoteBalance) / Number(baseBalance);
                    const priceInSol = price / 1e3;
                    marketcap = priceInSol * 1_000_000_000;

                    const solPriceUsd = await getSolPriceUsd();
                    if (solPriceUsd !== null && solPriceUsd > 0) {
                      priceUsd = priceInSol * solPriceUsd;
                      marketcapUsd = priceUsd * 1_000_000_000;
                    }
                  }
                }
              } catch (accountError) {
                console.warn(`Failed to fetch token accounts for migrated coin ${mintPubkey.toString()}:`, accountError instanceof Error ? accountError.message : String(accountError));
              }
            }
          }
        } catch (decodeError) {
          try {
            const poolPubkey = poolAccountInfo.pubkey;
            const [poolBaseTokenAccount] = PublicKey.findProgramAddressSync(
              [poolPubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
              PUMP_AMM_PROGRAM_ID
            );

            const [poolQuoteTokenAccount] = PublicKey.findProgramAddressSync(
              [poolPubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), WSOL_MINT.toBuffer()],
              PUMP_AMM_PROGRAM_ID
            );

            const [baseAccountInfo, quoteAccountInfo] = await Promise.all([
              connection.getParsedAccountInfo(poolBaseTokenAccount).catch(() => null),
              connection.getParsedAccountInfo(poolQuoteTokenAccount).catch(() => null)
            ]);

            if (baseAccountInfo?.value && quoteAccountInfo?.value) {
              const baseParsed = (baseAccountInfo.value.data as any).parsed?.info;
              const quoteParsed = (quoteAccountInfo.value.data as any).parsed?.info;
              
              if (baseParsed?.tokenAmount && quoteParsed?.tokenAmount) {
                const baseBalance = BigInt(baseParsed.tokenAmount.amount || '0');
                const quoteBalance = BigInt(quoteParsed.tokenAmount.amount || '0');

                if (baseBalance > 0n && quoteBalance > 0n) {
                  price = Number(quoteBalance) / Number(baseBalance);
                  const priceInSol = price / 1e3;
                  marketcap = priceInSol * 1_000_000_000;

                  const solPriceUsd = await getSolPriceUsd();
                  if (solPriceUsd !== null && solPriceUsd > 0) {
                    priceUsd = priceInSol * solPriceUsd;
                    marketcapUsd = priceUsd * 1_000_000_000;
                  }
                }
              }
            }
          } catch (fallbackError) {
            console.warn(`Failed to fetch pool reserves for migrated coin ${mintPubkey.toString()}:`, fallbackError instanceof Error ? fallbackError.message : String(fallbackError));
          }
        }
      }
    } catch (poolError) {
      console.warn(`Failed to fetch pool data for migrated coin ${mintPubkey.toString()}:`, poolError instanceof Error ? poolError.message : String(poolError));
    }
  } else if (decoded && decoded.virtual_sol_reserves !== undefined && decoded.virtual_token_reserves !== undefined) {
    const virtualSolReserves = typeof decoded.virtual_sol_reserves === 'bigint' 
      ? Number(decoded.virtual_sol_reserves) 
      : decoded.virtual_sol_reserves;
    const virtualTokenReserves = typeof decoded.virtual_token_reserves === 'bigint' 
      ? Number(decoded.virtual_token_reserves) 
      : decoded.virtual_token_reserves;

    if (virtualTokenReserves > 0) {
      price = virtualSolReserves / virtualTokenReserves;
      
      const priceInSol = price / 1e3;
      
      marketcap = priceInSol * 1_000_000_000;

      const solPriceUsd = await getSolPriceUsd();
      if (solPriceUsd !== null && solPriceUsd > 0) {
        priceUsd = priceInSol * solPriceUsd;
        
        marketcapUsd = priceUsd * 1_000_000_000;
      }
    }
  }

  return {
    mint: mintPubkey.toString(),
    bondingCurve: bondingCurve.toString(),
    migrated: migrated,
    creator: creator || '',
    isMayhemMode: decoded?.is_mayhem_mode || false,
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
      
      const isRateLimit = error?.message?.includes('429') || 
                         error?.message?.includes('Too many requests') ||
                         error?.code === 429;
      
      if (!isRateLimit || attempt === maxRetries - 1) {
        throw error;
      }
      
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

