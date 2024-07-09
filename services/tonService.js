const TonWeb = require('tonweb');
const { HttpClient, Api } = require('tonapi-sdk-js');
const fs = require('fs').promises;
const axios = require('axios'); // اضافه کردن axios
const Transaction = require('../models/transaction');
const api = require('../utils/api');
const amqp = require('amqplib');
require('dotenv').config();
const vault = require('node-vault')({
    apiVersion: 'v1',
    endpoint: process.env.VAULT_ENDPOINT,
    token: process.env.VAULT_TOKEN
});

class TonService {
    constructor() {
        this.tonweb = new TonWeb(new TonWeb.HttpProvider(process.env.TONCENTER_API_URL, {
            apiKey: process.env.TONCENTER_API_KEY
        }));
        const httpClient = new HttpClient({
            baseUrl: process.env.TON_API_URL,
            baseApiParams: {
                headers: {
                    Authorization: `Bearer ${process.env.TON_API_KEY}`,
                    'Content-type': 'application/json'
                }
            }
        });
        this.tonApi = new Api(httpClient);
        this.cache = {}; // تعریف cache برای نگهداری تراکنش‌های در حال پردازش

        this.tokenAddresses = {};
        this.publicKey = null;
        this.privateKey = null;
        this.init();
    }

    async init() {
        try {
            const { publicKey, privateKey } = await this.getKeysFromVault();
            this.publicKey = TonWeb.utils.base64ToBytes(publicKey);
            this.privateKey = TonWeb.utils.base64ToBytes(privateKey);
            this.wallet = new TonWeb.Wallets.all.v4R2(this.tonweb.provider, {
                publicKey: this.publicKey,
                secretKey: this.privateKey
            });

            await this.updateTokenAddresses(process.env.WALLET_ADDRESS);
            this.tokenAddresses = JSON.parse(await fs.readFile('config/contracts.json', 'utf8'));
            console.log('Token addresses loaded successfully');

            await this.connectToRabbitMQ();  // اتصال به RabbitMQ

        } catch (error) {
            console.error('Error initializing:', error.message);
            process.exit(1); // خروج از برنامه در صورت بروز خطا
        }

        this.monitorWallet(process.env.WALLET_ADDRESS);
    }

    async getKeysFromVault() {
        try {
            const result = await vault.read(process.env.VAULT_PATH);
            return {
                publicKey: result.data.publicKey,
                privateKey: result.data.privateKey
            };
        } catch (error) {
            console.error('Error retrieving keys from Vault:', error.message);
            throw new Error('Failed to retrieve keys');
        }
    }

    async updateTokenAddresses(accountId) {
        try {
            const response = await this.tonApi.accounts.getAccountJettonsBalances(accountId);
            const balances = response.balances;

            const tokenAddresses = {};

            for (const balance of balances) {
                const { symbol } = balance.jetton;
                const walletAddress = balance.wallet_address.address;
                tokenAddresses[walletAddress] = symbol; // آدرس قرارداد ها به عنوان کلید و نماد به عنوان مقدار
            }

            await fs.writeFile('config/contracts.json', JSON.stringify(tokenAddresses, null, 2));
            console.log('Token addresses updated successfully.');
        } catch (error) {
            console.error('Error updating token addresses:', error.message);
            throw new Error(error.message);
        }
    }

    async monitorWallet(walletAddress) {
        setInterval(async () => {
            const transactions = await this.getTransactions(walletAddress);
            for (const tx of transactions) {
                if (tx && tx.hash && (tx.in_msg || tx.out_msgs)) {
                    await this.handleTransaction(tx);
                }
            }
        }, parseInt(process.env.CHECK_INTERVAL));

        // ارسال تراکنش‌های تایید نشده به API
        setInterval(async () => {
            await this.sendPendingTransactionsToAPI();
        }, parseInt(process.env.CHECK_INTERVAL));

        // بررسی و به‌روزرسانی تراکنش‌ها هر 2 ثانیه
        setInterval(async () => {
            await this.checkAndUpdateTransactions();
        }, parseInt(process.env.UPDATE_INTERVAL));
    }

    async getTransactions(walletAddress) {
        try {
            const response = await this.tonApi.blockchain.getBlockchainAccountTransactions(walletAddress, { limit: parseInt(process.env.LIMIT) });
            return response.transactions;
        } catch (error) {
            console.error('Error fetching transactions:', error);
            return [];
        }
    }

    async handleTransaction(tx) {
        const txId = tx.hash;

        let from, to, amount, memo, token;

        if (tx.in_msg && tx.in_msg.source && this.tokenAddresses[tx.in_msg.source.address]) {
            // تطبیق نام توکن‌ها با توکن‌های موجود در config/contracts.json
            token = this.tokenAddresses[tx.in_msg.source.address];
            from = tx.in_msg.decoded_body.sender || tx.in_msg.source.address;
            to = tx.in_msg.destination.address;
            amount = tx.in_msg.decoded_body.amount || tx.in_msg.value;
            memo = tx.in_msg.decoded_body.forward_payload?.value?.value?.text || '';
        } else if (tx.in_msg && tx.in_msg.source && !tx.in_msg.decoded_body?.forward_payload) {
            // تراکنش ارز TON
            from = tx.in_msg.source?.address || '';
            to = tx.in_msg.destination?.address || '';
            amount = tx.in_msg.value;
            memo = tx.in_msg.decoded_body?.text || '';
            token = 'TON';
        } else if (tx.out_msgs && tx.out_msgs.length > 0) {
            let out_msg = tx.out_msgs[0];
            from = out_msg.source?.address || '';
            if (out_msg.decoded_op_name == 'jetton_transfer' && this.tokenAddresses[out_msg.destination.address]) {
                to = out_msg.decoded_body?.destination || '';
                amount = out_msg.decoded_body?.amount || '0';
                token = this.tokenAddresses[out_msg.destination.address];
                memo = out_msg.decoded_body?.forward_payload?.value?.value?.text || '-'
            } else if (out_msg.decoded_op_name != 'jetton_transfer') {
                to = out_msg.destination?.address || '';
                amount = out_msg.value;
                token = 'TON';
                memo = out_msg.decoded_body?.text || '-'
            } else {
                return;
            }
        } else {
            return;
        }

        try {
            const existingTx = await Transaction.findOne({ txId });

            if (existingTx) {
                // آپدیت وضعیت success در صورت تغییر
                if (!existingTx.success && existingTx.success !== tx.success) {
                    existingTx.success = tx.success;
                    existingTx.tx = tx;
                    existingTx.sentToAPI = false;
                    existingTx.lastChecked = new Date(); // بروزرسانی lastChecked
                    await existingTx.save();
                    await this.sendToAPI(existingTx);
                }
            } else {
                // بررسی اینکه آیا تراکنش در حال پردازش است یا خیر
                if (this.cache[txId]) {
                    console.log(`Transaction ${txId} is already being processed.`);
                    return;
                }

                this.cache[txId] = true; // اضافه کردن تراکنش به cache موقت

                const newTx = new Transaction({
                    txId,
                    from,
                    to,
                    value: amount,
                    token,
                    memo,
                    success: tx.success,
                    tx: tx,
                    sentToAPI: false,
                    lastChecked: new Date(), // تنظیم مقدار اولیه برای lastChecked
                    createdAt: new Date() // تنظیم مقدار اولیه برای createdAt
                });

                await newTx.save();
                await this.sendToAPI(newTx);
            }
        } catch (error) {
            console.error(`Error processing transaction ${txId}:`, error.message);
        } finally {
            delete this.cache[txId]; // حذف تراکنش از cache پس از ذخیره یا بروزرسانی
        }
    }

    async sendToAPI(transaction) {
        try {
            const response = await api.sendTransaction({
                txId: transaction.txId,
                from: transaction.from,
                to: transaction.to,
                value: transaction.value,
                token: transaction.token,
                memo: transaction.memo,
                success: transaction.success,
                tx: transaction.tx // ارسال آبجکت کامل tx به API
            });
            if (response.status === 200) {
                transaction.sentToAPI = true;
                await transaction.save();
            }
            await this.sendToRabbitMQ(transaction); // ارسال تراکنش به RabbitMQ
        } catch (error) {
            console.error('Error sending transaction to API:', error.message);
        }
    }

    async sendPendingTransactionsToAPI() {
        const pendingTransactions = await Transaction.find({ sentToAPI: false });
        for (const tx of pendingTransactions) {
            await this.sendToAPI(tx);
        }
    }

    async checkAndUpdateTransactions() {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

        // یافتن تراکنش‌هایی که success آنها false است و بیشتر از 10 دقیقه از ذخیره‌سازی آنها گذشته است
        const transactions = await Transaction.find({
            success: false,
            lastChecked: { $lt: fiveMinutesAgo },
            createdAt: { $gt: oneHourAgo }
        }).sort({ lastChecked: 1 }).limit(1);

        for (const tx of transactions) {
            try {
                const tcDetail = await this.getTransactionInfoByHash(tx.txId);
                if (tcDetail && tcDetail.description && tcDetail.description.action && tcDetail.description.action.success) {
                    tx.success = true;
                }
                tx.lastChecked = new Date();
                await tx.save();
            } catch (error) {
                console.error(`Error updating transaction ${tx.txId}:`, error.message);
            }
        }
    }

    async sendTon(toAddress, amount, memo) {
        try {
            const secretKey = this.privateKey;

            let seqno = await this.wallet.methods.seqno().call();
            if (seqno === null || seqno === undefined) {
                seqno = 0;
            }

            const transfer = this.wallet.methods.transfer({
                secretKey: secretKey,
                toAddress: toAddress,
                amount: TonWeb.utils.toNano(amount),
                seqno: seqno,
                sendMode: 3,
                payload: memo
            });

            const result = await transfer.send();
            console.log('Transaction Result:', result);

            return { success: true, result };
        } catch (error) {
            console.error('Error sending transaction:', error.message);
            throw new Error(error.message);
        }
    }

    async sendToken(toAddress, tokenContractAddress, tokenAmount, memo) {
        try {
            const jettonWallet = new TonWeb.token.jetton.JettonWallet(this.tonweb, { address: tokenContractAddress });
            const senderPrivateKey = this.privateKey;

            let seqno = await this.wallet.methods.seqno().call();
            if (seqno === null || seqno === undefined) {
                seqno = 0;
            }

            const amount = TonWeb.utils.toNano(tokenAmount);
            const payload = await jettonWallet.createTransferBody({
                jettonAmount: amount,
                toAddress: new TonWeb.utils.Address(toAddress),
                forwardAmount: TonWeb.utils.toNano('0.01'),
                forwardPayload: new Uint8Array([... new Uint8Array(4), ... new TextEncoder().encode(memo)]),
                responseAddress: new TonWeb.utils.Address(process.env.WALLET_ADDRESS)
            });

            const result = await this.wallet.methods.transfer({
                secretKey: senderPrivateKey,
                toAddress: tokenContractAddress,
                amount: TonWeb.utils.toNano('0.05'), // مقدار TON برای پوشش هزینه‌های انتقال
                seqno: seqno,
                payload: payload,
                sendMode: 3
            }).send();

            console.log('sendToken Transaction Result:', result);
            return { success: true, result };
        } catch (error) {
            console.error('Error sending token:', error.message);
            throw new Error(error.message);
        }
    }

    async createWallet() {
        try {
            const keyPair = TonWeb.utils.nacl.sign.keyPair();
            const publicKey = keyPair.publicKey;
            const secretKey = keyPair.secretKey;

            const wallet = new TonWeb.wallet.all.v4R2(this.tonweb.provider, {
                publicKey: publicKey
            });

            const walletAddress = await wallet.getAddress();

            return {
                publicKey: TonWeb.utils.bytesToBase64(publicKey),
                secretKey: TonWeb.utils.bytesToBase64(secretKey),
                address: walletAddress.toString(true, true, true)
            };
        } catch (error) {
            console.error('Error creating wallet:', error.message);
            throw new Error(error.message);
        }
    }

    async getTransactionInfoByHash(transactionHash) {
        try {
            const response = await axios.get(`https://toncenter.com/api/v3/adjacentTransactions`, {
                headers: {
                    'X-API-Key': process.env.TONCENTER_API_KEY
                },
                params: {
                    hash: transactionHash,
                    direction: 'both',
                    limit: 1,
                }
            });

            if (response.data.transactions && response.data.transactions.length > 0) {
                return response.data.transactions[0];
            } else {
                throw new Error('Transaction not found');
            }
        } catch (error) {
            console.error('Error fetching transaction info:', error);
            throw error;
        }
    }

    async connectToRabbitMQ() {
        try {
            this.rabbitMQConnection = await amqp.connect(process.env.RABBITMQ_URL);
            this.rabbitMQChannel = await this.rabbitMQConnection.createChannel();
            await this.rabbitMQChannel.assertQueue(process.env.RABBITMQ_QUEUE, { durable: true });
            console.log('Connected to RabbitMQ');
        } catch (error) {
            console.error('Error connecting to RabbitMQ:', error.message);
        }
    }

    async sendToRabbitMQ(transaction) {
        if (this.rabbitMQChannel) {
            try {
                const message = JSON.stringify(transaction);
                this.rabbitMQChannel.sendToQueue(process.env.RABBITMQ_QUEUE, Buffer.from(message), { persistent: true });
                console.log('Transaction sent to RabbitMQ:', transaction.txId);
            } catch (error) {
                console.error('Error sending transaction to RabbitMQ:', error.message);
            }
        } else {
            console.error('RabbitMQ channel is not initialized.');
        }
    }

}

module.exports = TonService;
