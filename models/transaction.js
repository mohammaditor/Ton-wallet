const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    txId: { type: String, required: true, unique: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    value: { type: String, required: true },
    token: { type: String, required: true },
    memo: { type: String, required: false },
    success: { type: Boolean, required: true },
    tx: { type: Object},
    sentToAPI: { type: Boolean, default: false },
    lastChecked: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transaction', transactionSchema);
