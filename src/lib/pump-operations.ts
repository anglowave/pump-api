import { Connection, PublicKey, Transaction, AccountInfo, Keypair, sendAndConfirmTransaction } from '@solana/web3.js'
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount, bondingCurvePda, PUMP_PROGRAM_ID } from '@pump-fun/pump-sdk'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token'
import BN from 'bn.js'
import bs58 from 'bs58'

export interface BuyRequest {
	mint: string
	user: string
	solAmount: number | string
	slippage?: number
	privateKey: number[] | string
}

export interface BuyResponse {
	signature: string
	estimatedTokenAmount: string
}

export interface SellRequest {
	mint: string
	user: string
	percentage: number
	slippage?: number
	privateKey: number[] | string
}

export interface SellResponse {
	signature: string
	estimatedSolAmount: string
}

export interface CreateRequest {
	name: string
	symbol: string
	uri: string
	creator: string
	user: string
	mint?: string
	initialBuySolAmount?: number | string
	slippage?: number
	mayhemMode?: boolean
	privateKey: number[] | string
}

export interface CreateResponse {
	signature: string
	mint: string
	estimatedTokenAmount?: string
}

export class PumpOperations {
	private readonly connection: Connection
	private readonly onlineSdk: OnlinePumpSdk

	constructor() {
		const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com'
		this.connection = new Connection(rpcUrl, 'confirmed')
		this.onlineSdk = new OnlinePumpSdk(this.connection)
	}

	private parsePrivateKey(privateKey: number[] | string): Keypair {
		try {
			let privateKeyBytes: Uint8Array
			
			if (typeof privateKey === 'string') {
				try {
					const parsed = JSON.parse(privateKey)
					if (Array.isArray(parsed)) {
						privateKeyBytes = Uint8Array.from(parsed)
					} else {
						throw new Error('JSON private key must be an array')
					}
				} catch (jsonError) {
					try {
						privateKeyBytes = bs58.decode(privateKey)
					} catch (base58Error) {
						throw new Error('Private key must be either a JSON array of numbers or a base58 string')
					}
				}
			} else {
				privateKeyBytes = Uint8Array.from(privateKey)
			}

			if (privateKeyBytes.length !== 64) {
				throw new Error(`Private key must be 64 bytes, got ${privateKeyBytes.length}`)
			}

			return Keypair.fromSecretKey(privateKeyBytes)
		} catch (error) {
			throw new Error(`Failed to parse private key: ${error instanceof Error ? error.message : 'Invalid format'}`)
		}
	}

	private async executeTransaction(transaction: Transaction, keypair: Keypair): Promise<string> {
		const { blockhash } = await this.connection.getLatestBlockhash('confirmed')
		transaction.recentBlockhash = blockhash
		transaction.feePayer = keypair.publicKey
		transaction.sign(keypair)

		const signature = await sendAndConfirmTransaction(
			this.connection,
			transaction,
			[keypair],
			{
				commitment: 'confirmed',
				skipPreflight: false
			}
		)

		return signature
	}

	async executeBuy(request: BuyRequest): Promise<BuyResponse> {
		const { mint, user, solAmount, slippage = 1, privateKey } = request

		const mintPubkey = new PublicKey(mint)
		const userPubkey = new PublicKey(user)
		const keypair = this.parsePrivateKey(privateKey)

		const global = await this.onlineSdk.fetchGlobal()
		let bondingCurveAccountInfo: AccountInfo<Buffer>
		let bondingCurve: any
		let associatedUserAccountInfo: AccountInfo<Buffer> | null
		
		try {
			const buyState = await this.onlineSdk.fetchBuyState(mintPubkey, userPubkey, TOKEN_PROGRAM_ID)
			bondingCurveAccountInfo = buyState.bondingCurveAccountInfo as AccountInfo<Buffer>
			bondingCurve = buyState.bondingCurve
			associatedUserAccountInfo = buyState.associatedUserAccountInfo as AccountInfo<Buffer> | null
		} catch (error) {
			const rpcUrl = this.connection.rpcEndpoint
			const network = rpcUrl.includes('devnet') ? 'devnet' : rpcUrl.includes('testnet') ? 'testnet' : 'mainnet'
			
			try {
				const bondingCurvePdaAddress = bondingCurvePda(mintPubkey)
				const bondingCurveAccount = await this.connection.getAccountInfo(bondingCurvePdaAddress)
				const mintAccount = await this.connection.getAccountInfo(mintPubkey)
				
				if (!mintAccount) {
					throw new Error(`Mint account ${mintPubkey.toString()} does not exist on ${network}. Please verify the mint address is correct.`)
				}
				
				if (!bondingCurveAccount) {
					throw new Error(`Bonding curve account not found for mint: ${mintPubkey.toString()} on ${network}. The bonding curve PDA (${bondingCurvePdaAddress.toString()}) was derived using program ID ${PUMP_PROGRAM_ID.toString()}. This may mean: 1) The token was never created on pump.fun, 2) The token was created with a different program ID (pump.fun on devnet may use a different program ID), or 3) The mint address is incorrect.`)
				} else {
					throw new Error(`Bonding curve account exists (${bondingCurvePdaAddress.toString()}) but is owned by program ${bondingCurveAccount.owner.toString()}, not the expected pump program (${PUMP_PROGRAM_ID.toString()}). This indicates the token was created with a different program ID. On devnet, pump.fun may use a different program ID than mainnet.`)
				}
			} catch (debugError) {
				if (error instanceof Error && error.message.includes('Bonding curve account not found')) {
					throw new Error(`Bonding curve account not found for mint: ${mintPubkey.toString()} on ${network}. ${debugError instanceof Error ? debugError.message : 'Unknown error'}`)
				}
				throw error
			}
		}
		
		const feeConfig = await this.onlineSdk.fetchFeeConfig().catch(() => null)

		const solAmountBN = typeof solAmount === 'string' ? new BN(solAmount) : new BN(Math.floor(Number(solAmount) * 1e9))
		const tokenAmount = getBuyTokenAmountFromSolAmount({
			global,
			feeConfig,
			mintSupply: bondingCurve.tokenTotalSupply,
			bondingCurve,
			amount: solAmountBN
		})

		const instructions = await PUMP_SDK.buyInstructions({
			global,
			bondingCurveAccountInfo: bondingCurveAccountInfo as AccountInfo<Buffer>,
			bondingCurve,
			associatedUserAccountInfo: associatedUserAccountInfo as AccountInfo<Buffer> | null,
			mint: mintPubkey,
			user: userPubkey,
			solAmount: solAmountBN,
			amount: tokenAmount,
			slippage,
			tokenProgram: TOKEN_2022_PROGRAM_ID
		})

		const transaction = new Transaction()
		transaction.add(...instructions)

		const signature = await this.executeTransaction(transaction, keypair)

		return {
			signature,
			estimatedTokenAmount: tokenAmount.toString()
		}
	}

	async executeSell(request: SellRequest): Promise<SellResponse> {
		const { mint, user, percentage, slippage = 1, privateKey } = request

		if (percentage <= 0 || percentage > 100) {
			throw new Error('Percentage must be between 0 and 100')
		}

		const mintPubkey = new PublicKey(mint)
		const userPubkey = new PublicKey(user)
		const keypair = this.parsePrivateKey(privateKey)

		const global = await this.onlineSdk.fetchGlobal()
		let bondingCurveAccountInfo: AccountInfo<Buffer>
		let bondingCurve: any
		let tokenProgram: PublicKey
		let userBalance: BN
		
		try {
			const bondingCurvePdaAddress = bondingCurvePda(mintPubkey)
			const bondingCurveInfo = await this.connection.getAccountInfo(bondingCurvePdaAddress)
			
			if (!bondingCurveInfo) {
				throw new Error(`Bonding curve account not found for mint: ${mintPubkey.toString()}`)
			}

			bondingCurveAccountInfo = bondingCurveInfo as AccountInfo<Buffer>
			bondingCurve = PUMP_SDK.decodeBondingCurve(bondingCurveAccountInfo)
			
			const suggestedTokenProgram = bondingCurve.isMayhemMode ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
			const otherTokenProgram = bondingCurve.isMayhemMode ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID
			
			let sellState: any = null
			let foundTokenProgram: PublicKey | null = null
			
			try {
				sellState = await this.onlineSdk.fetchSellState(mintPubkey, userPubkey, suggestedTokenProgram)
				foundTokenProgram = suggestedTokenProgram
			} catch (error) {
				try {
					sellState = await this.onlineSdk.fetchSellState(mintPubkey, userPubkey, otherTokenProgram)
					foundTokenProgram = otherTokenProgram
				} catch (error2) {
					throw new Error(`Token account not found for user ${userPubkey.toString()} and mint ${mintPubkey.toString()}. Tried both TOKEN_PROGRAM_ID (${TOKEN_PROGRAM_ID.toString()}) and TOKEN_2022_PROGRAM_ID (${TOKEN_2022_PROGRAM_ID.toString()}). The user may not own any tokens, or the token account may not exist yet.`)
				}
			}
			
			if (!sellState || !foundTokenProgram) {
				throw new Error(`Failed to fetch sell state for user ${userPubkey.toString()} and mint ${mintPubkey.toString()}`)
			}
			
			tokenProgram = foundTokenProgram
			bondingCurveAccountInfo = sellState.bondingCurveAccountInfo as AccountInfo<Buffer>
			bondingCurve = sellState.bondingCurve
			
			const associatedTokenAddress = getAssociatedTokenAddressSync(mintPubkey, userPubkey, true, tokenProgram)
			const tokenAccountParsed = await getAccount(this.connection, associatedTokenAddress, 'confirmed', tokenProgram)
			
			if (!tokenAccountParsed.mint.equals(mintPubkey)) {
				throw new Error(`Token account mint mismatch. Account has mint ${tokenAccountParsed.mint.toString()}, but expected ${mintPubkey.toString()}`)
			}
			
			if (!tokenAccountParsed.owner.equals(userPubkey)) {
				throw new Error(`Token account owner mismatch. Account has owner ${tokenAccountParsed.owner.toString()}, but expected ${userPubkey.toString()}`)
			}
			
			userBalance = new BN(tokenAccountParsed.amount.toString())
		} catch (error) {
			const rpcUrl = this.connection.rpcEndpoint
			const network = rpcUrl.includes('devnet') ? 'devnet' : rpcUrl.includes('testnet') ? 'testnet' : 'mainnet'
			
			try {
				const bondingCurvePdaAddress = bondingCurvePda(mintPubkey)
				const bondingCurveAccount = await this.connection.getAccountInfo(bondingCurvePdaAddress)
				const mintAccount = await this.connection.getAccountInfo(mintPubkey)
				
				if (!mintAccount) {
					throw new Error(`Mint account ${mintPubkey.toString()} does not exist on ${network}. Please verify the mint address is correct.`)
				}
				
				if (!bondingCurveAccount) {
					throw new Error(`Bonding curve account not found for mint: ${mintPubkey.toString()} on ${network}. The bonding curve PDA (${bondingCurvePdaAddress.toString()}) was derived using program ID ${PUMP_PROGRAM_ID.toString()}. This may mean: 1) The token was never created on pump.fun, 2) The token was created with a different program ID (pump.fun on devnet may use a different program ID), or 3) The mint address is incorrect.`)
				} else {
					throw new Error(`Bonding curve account exists (${bondingCurvePdaAddress.toString()}) but is owned by program ${bondingCurveAccount.owner.toString()}, not the expected pump program (${PUMP_PROGRAM_ID.toString()}). This indicates the token was created with a different program ID. On devnet, pump.fun may use a different program ID than mainnet.`)
				}
			} catch (debugError) {
				if (error instanceof Error && error.message.includes('Bonding curve account not found')) {
					throw new Error(`Bonding curve account not found for mint: ${mintPubkey.toString()} on ${network}. ${debugError instanceof Error ? debugError.message : 'Unknown error'}`)
				}
				throw error
			}
		}

		if (userBalance.isZero()) {
			throw new Error(`User ${userPubkey.toString()} has zero balance for token ${mintPubkey.toString()}`)
		}

		const percentageBN = new BN(percentage)
		const tokenAmountBN = userBalance.mul(percentageBN).div(new BN(100))

		if (tokenAmountBN.isZero()) {
			throw new Error(`Calculated token amount is zero. User balance: ${userBalance.toString()}, Percentage: ${percentage}%`)
		}

		if (tokenAmountBN.gt(userBalance)) {
			throw new Error(`Calculated sell amount (${tokenAmountBN.toString()}) exceeds user balance (${userBalance.toString()}). User balance: ${userBalance.toString()}, Percentage: ${percentage}%, Token program: ${tokenProgram.toString()}`)
		}
		
		const feeConfig = await this.onlineSdk.fetchFeeConfig().catch(() => null)

		const solAmount = getSellSolAmountFromTokenAmount({
			global,
			feeConfig,
			mintSupply: bondingCurve.tokenTotalSupply,
			bondingCurve,
			amount: tokenAmountBN
		})

		const instructions = await PUMP_SDK.sellInstructions({
			global,
			bondingCurveAccountInfo: bondingCurveAccountInfo as AccountInfo<Buffer>,
			bondingCurve,
			mint: mintPubkey,
			user: userPubkey,
			amount: tokenAmountBN,
			solAmount,
			slippage,
			tokenProgram: tokenProgram,
			mayhemMode: bondingCurve.isMayhemMode
		})

		const transaction = new Transaction()
		transaction.add(...instructions)

		const signature = await this.executeTransaction(transaction, keypair)

		return {
			signature,
			estimatedSolAmount: solAmount.toString()
		}
	}

	async executeCreate(request: CreateRequest): Promise<CreateResponse> {
		const { name, symbol, uri, creator, user, mint, initialBuySolAmount, slippage = 1, mayhemMode = false, privateKey } = request

		const creatorPubkey = new PublicKey(creator)
		const userPubkey = new PublicKey(user)
		const mintPubkey = mint ? new PublicKey(mint) : PublicKey.unique()
		const keypair = this.parsePrivateKey(privateKey)

		let instructions: any[]
		let estimatedTokenAmount: string | undefined

		if (initialBuySolAmount !== undefined && Number(initialBuySolAmount) > 0) {
			const global = await this.onlineSdk.fetchGlobal()
			const feeConfig = await this.onlineSdk.fetchFeeConfig().catch(() => null)
			const solAmountBN = typeof initialBuySolAmount === 'string' 
				? new BN(initialBuySolAmount) 
				: new BN(Math.floor(Number(initialBuySolAmount) * 1e9))
			
			const tokenAmount = getBuyTokenAmountFromSolAmount({
				global,
				feeConfig,
				mintSupply: null,
				bondingCurve: null,
				amount: solAmountBN
			})
			estimatedTokenAmount = tokenAmount.toString()

			instructions = await PUMP_SDK.createV2AndBuyInstructions({
				global,
				mint: mintPubkey,
				name,
				symbol,
				uri,
				creator: creatorPubkey,
				user: userPubkey,
				solAmount: solAmountBN,
				amount: tokenAmount,
				mayhemMode
			})
		} else {
			const createIx = await PUMP_SDK.createV2Instruction({
				mint: mintPubkey,
				name,
				symbol,
				uri,
				creator: creatorPubkey,
				user: userPubkey,
				mayhemMode
			})
			instructions = [createIx]
		}

		const transaction = new Transaction()
		transaction.add(...instructions)

		const signature = await this.executeTransaction(transaction, keypair)

		return {
			signature,
			mint: mintPubkey.toString(),
			estimatedTokenAmount
		}
	}

	getRpcUrl(): string {
		return this.connection.rpcEndpoint
	}
}
