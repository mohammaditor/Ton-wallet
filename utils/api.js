const axios = require('axios');
require('dotenv').config();

class API {
    async sendTransaction(transaction) {
        try {
            const response = await axios.post(process.env.API_URL, transaction);
            return response;
        } catch (error) {
            console.error('Error sending transaction to API:', error);
            return { status: 500 };
        }
    }
}

module.exports = new API();
