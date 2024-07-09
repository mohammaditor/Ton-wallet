const TonService = require('../services/tonService');

class TransactionController {
    constructor() {
        this.tonService = new TonService();
    }

    startMonitoring(walletAddress) {
        this.tonService.monitorWallet(walletAddress);
    }
}

module.exports = TransactionController;
