import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import pumpIdl from '../../config/idl/pump/idl.json';
import pumpAmmIdl from '../../config/idl/pump_amm/idl.json';

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

export interface TokenInfo {
  mint: string;
  bondingCurve: string;
  complete: boolean;
  creator: string;
  isMayhemMode: boolean;
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

/**
 * Derives the bonding curve PDA from a mint address
 */
export async function deriveBondingCurve(mint: string | PublicKey): Promise<PublicKey> {
  const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return bondingCurve;
}

/**
 * Fetches bonding curve address from a mint address
 */
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

/**
 * Fetches token metadata from the mint account
 */
async function getTokenMetadata(
  mint: PublicKey,
  connection: Connection
): Promise<{ name?: string; symbol?: string; uri?: string; decimals?: number; supply?: string } | undefined> {
  try {
    // Use jsonParsed encoding to get parsed token info
    const accountInfo = await connection.getParsedAccountInfo(mint, {
      commitment: 'confirmed'
    });

    if (!accountInfo.value) {
      return undefined;
    }

    const parsed = accountInfo.value.data;
    
    // Check if it's a parsed token account
    if (parsed && typeof parsed === 'object' && 'parsed' in parsed) {
      const parsedData = (parsed as any).parsed;
      
      if (parsedData && parsedData.type === 'mint' && parsedData.info) {
        const info = parsedData.info;
        const metadata: { name?: string; symbol?: string; uri?: string; decimals?: number; supply?: string } = {
          decimals: info.decimals,
          supply: info.supply?.toString()
        };

        // Check for Token-2022 extensions (metadataPointer and tokenMetadata)
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
    // If parsing fails, try to get basic info from raw account
    try {
      const rawAccount = await connection.getAccountInfo(mint);
      if (rawAccount) {
        // For regular SPL tokens, we'd need to query Metaplex metadata
        // For now, just return undefined if we can't parse it
        return undefined;
      }
    } catch (rawError) {
      // Ignore errors
    }
    return undefined;
  }
}

/**
 * Fetches complete token information from a mint address
 */
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

  // Fetch bonding curve info and metadata in parallel
  const bondingCurve = await deriveBondingCurve(mintPubkey);
  const [accountInfo, metadata] = await Promise.all([
    connection.getAccountInfo(bondingCurve),
    getTokenMetadata(mintPubkey, connection)
  ]);
  
  if (!accountInfo) {
    throw new Error(`Bonding curve not found for mint: ${mintPubkey.toString()}. The bonding curve account does not exist. This may mean: 1) The token was never created on pump.fun, 2) The bonding curve was closed/migrated, or 3) The mint address is incorrect.`);
  }

  // Determine which program owns the account and use the appropriate IDL
  const programId = accountInfo.owner;
  let coder: BorshCoder;
  
  if (programId.equals(PUMP_PROGRAM_ID)) {
    coder = new BorshCoder(pumpIdl as Idl);
  } else if (programId.equals(PUMP_AMM_PROGRAM_ID)) {
    coder = new BorshCoder(pumpAmmIdl as Idl);
  } else {
    throw new Error(`Bonding curve account is owned by unknown program: ${programId.toString()}. Expected pump or pump_amm program.`);
  }

  const decoded = decodeBondingCurve(accountInfo.data, coder);
  
  // If decoding fails, still return metadata if available (without error)
  if (!decoded) {
    // If we have metadata, return it without error since we don't need bonding curve data
    if (metadata) {
      return {
        mint: mintPubkey.toString(),
        bondingCurve: bondingCurve.toString(),
        complete: false,
        creator: '',
        isMayhemMode: false,
        metadata: metadata
      };
    }
    
    // Only throw error if we don't have metadata either
    const programName = programId.equals(PUMP_PROGRAM_ID) ? 'pump' : 'pump_amm';
    throw new Error(`Failed to decode bonding curve data for mint: ${mintPubkey.toString()}. Account owner: ${programName} (${programId.toString()}). Account data length: ${accountInfo.data.length} bytes. The account may not be a valid BondingCurve account.`);
  }

  return {
    mint: mintPubkey.toString(),
    bondingCurve: bondingCurve.toString(),
    complete: decoded.complete || false,
    creator: decoded.creator?.toString() || '',
    isMayhemMode: decoded.is_mayhem_mode || false,
    metadata: metadata
  };
}

/**
 * Decodes bonding curve account data
 */
function decodeBondingCurve(accountData: Buffer, coder: BorshCoder): any | null {
  try {
    if (accountData.length < 8) {
      console.error('Account data too short:', accountData.length);
      return null;
    }

    const accountsCoder = coder.accounts as any;
    const discriminator = Array.from(accountData.slice(0, 8));
    
    // Log discriminator for debugging
    console.log('BondingCurve discriminator:', discriminator);
    console.log('Account data length:', accountData.length);
    
    // Method 1: Try decoding with BondingCurve layout directly (same as transactions.ts)
    // This is the most reliable method based on how transactions.ts does it
    if (accountsCoder && accountsCoder.layouts && accountsCoder.layouts['BondingCurve']) {
      try {
        const accountLayout = accountsCoder.layouts['BondingCurve'];
        const decoded = accountLayout.decode(accountData);
        if (decoded !== null && decoded !== undefined) {
          // Verify we got valid data by checking for expected fields
          if (decoded.virtual_token_reserves !== undefined || decoded.virtual_sol_reserves !== undefined) {
            console.log('Successfully decoded using BondingCurve layout');
            return decoded;
          } else {
            console.log('Decoded but missing expected fields:', Object.keys(decoded));
          }
        }
      } catch (layoutError) {
        console.error('Error decoding with BondingCurve layout:', layoutError instanceof Error ? layoutError.message : layoutError);
        if (layoutError instanceof Error && layoutError.stack) {
          console.error('Stack:', layoutError.stack);
        }
      }
    }
    
    // Method 2: Try using accountsCoder.decode (Anchor's standard method)
    if (accountsCoder && typeof accountsCoder.decode === 'function') {
      try {
        const decoded = accountsCoder.decode(accountData);
        if (decoded) {
          // Anchor returns { name: 'AccountName', data: {...} }
          if (decoded.name === 'BondingCurve' && decoded.data) {
            console.log('Successfully decoded using accountsCoder.decode');
            return decoded.data;
          }
          // Fallback: check if data is directly in decoded
          if (decoded.data && (decoded.data.virtual_token_reserves !== undefined || decoded.data.virtual_sol_reserves !== undefined)) {
            return decoded.data;
          }
          // Fallback: check if decoded itself has the fields
          if (decoded.virtual_token_reserves !== undefined || decoded.virtual_sol_reserves !== undefined) {
            return decoded;
          }
        }
      } catch (decodeError) {
        console.error('Error decoding with accountsCoder.decode:', decodeError instanceof Error ? decodeError.message : decodeError);
      }
    }
    
    // Method 3: Try decoding without discriminator (skip first 8 bytes)
    if (accountData.length > 8) {
      try {
        const dataWithoutDiscriminator = accountData.slice(8);
        if (accountsCoder && accountsCoder.layouts && accountsCoder.layouts['BondingCurve']) {
          const accountLayout = accountsCoder.layouts['BondingCurve'];
          const decoded = accountLayout.decode(dataWithoutDiscriminator);
          if (decoded !== null && decoded !== undefined) {
            if (decoded.virtual_token_reserves !== undefined || decoded.virtual_sol_reserves !== undefined) {
              console.log('Successfully decoded without discriminator');
              return decoded;
            }
          }
        }
      } catch (skipDiscriminatorError) {
        // All methods failed
      }
    }
    
    // Log debugging info for troubleshooting
    console.error('Failed to decode bonding curve - account data length:', accountData.length);
    console.error('First 8 bytes (discriminator):', discriminator);
    console.error('First 32 bytes (hex):', accountData.slice(0, 32).toString('hex'));
    return null;
  } catch (error) {
    console.error('Failed to decode bonding curve account data:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
      if (error.stack) {
        console.error('Stack:', error.stack);
      }
    }
    return null;
  }
}

