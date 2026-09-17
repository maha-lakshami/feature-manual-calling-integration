const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const url = 'https://herbal-scanning-disjoin.ngrok-free.dev/api/webhooks/plivo/hangup/149b7d2f-820c-4b40-b881-074c7ab72bc5';
const nonce = '13651370172896635577';
const expectedSignature = 'ooDw9Je5EmA8rbACfA0plheIiLFh0xVwHEK/+N9s5oA=';

const authToken = process.env.PLIVO_AUTH_TOKEN;

if (!authToken) {
  console.log('PLIVO_AUTH_TOKEN not found in .env');
  process.exit(1);
}

const computed = crypto.createHmac('sha256', authToken).update(`${url}${nonce}`).digest('base64');

console.log('Computed signature :', computed);
console.log('Expected signature :', expectedSignature);
console.log('MATCH:', computed === expectedSignature);
console.log('(Token length used:', authToken.length, ', shape:', authToken.slice(0, 3) + '...' + authToken.slice(-3), ')');