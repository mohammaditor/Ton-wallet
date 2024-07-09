const express = require('express');
const connectDB = require('./config/db');
const TonService = require('./services/tonService');

const app = express();
const port = process.env.PORT || 3000;

connectDB();

const tonService = new TonService();

app.use(express.json());

app.post('/send-ton', async (req, res) => {
    const { toAddress, amount, memo } = req.body;

    if (!toAddress || !amount) {
        return res.status(400).send({ error: 'toAddress and amount are required' });
    }

    try {
        const result = await tonService.sendTon(toAddress, amount, memo);
        res.status(200).send(result);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});


app.post('/send-token', async (req, res) => {
    const { toAddress, tokenContractAddress, amount, memo } = req.body;

    if (!toAddress || !tokenContractAddress || !amount) {
        return res.status(400).send({ error: 'toAddress, tokenContractAddress and amount are required' });
    }

    try {
        const result = await tonService.sendToken(toAddress, tokenContractAddress, amount, memo);
        res.status(200).send(result);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

app.post('/create-wallet', async (req, res) => {
    try {
        const wallet = await tonService.createWallet();
        res.json(wallet);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/fake', async (req, res) => {
    res.status(200).send();
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
