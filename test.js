const crypto = require('crypto');

const secret = process.env.LOYVERSE_WEBHOOK_SECRET || 'adac161b5b424d18860a8f9b51b212ce';
const payload = {
    receipt_number: '1-1001',
    total_money: 150.00,
    created_at: new Date().toISOString(),
    line_items: [
        {
            item_name: 'Espresso',
            quantity: 2,
            total_money: 100.00
        },
        {
            item_name: 'Croissant',
            quantity: 1,
            total_money: 50.00
        }
    ]
};

const payloadString = JSON.stringify(payload);
const signature = crypto.createHmac('sha1', secret).update(payloadString).digest('base64');

fetch('https://loyverse-discord-webhook.onrender.com/webhook/loyverse', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-Loyverse-Signature': signature
    },
    body: payloadString
})
.then(res => {
    console.log('Response status:', res.status);
    return res.text();
})
.then(text => console.log('Response text:', text))
.catch(err => console.error('Error:', err));
