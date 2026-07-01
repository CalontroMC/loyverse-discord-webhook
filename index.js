require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');
const axios = require('axios');
const { DateTime } = require('luxon');

const app = express();
const port = process.env.PORT || 3000;

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const LOYVERSE_SECRET = process.env.LOYVERSE_WEBHOOK_SECRET;
const LOYVERSE_ACCESS_TOKEN = process.env.LOYVERSE_ACCESS_TOKEN;

// Middleware to parse JSON and keep the raw body for signature verification
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// Webhook endpoint for real-time events
app.post('/webhook/loyverse', async (req, res) => {
    try {
        // 1. Verify Signature
        const signature = req.headers['x-loyverse-signature'];
        if (signature) {
            const hmac = crypto.createHmac('sha1', LOYVERSE_SECRET);
            const digest = hmac.update(req.rawBody).digest('base64');
            
            if (signature !== digest) {
                console.error('Invalid signature.', { expected: digest, received: signature });
                return res.status(401).send('Invalid signature');
            }
        } else {
            console.warn('No signature provided in the headers. Proceeding anyway for testing.');
            // In a strict environment, you would return 401 here.
        }

        const data = req.body || {};
        console.log('Received webhook data:', JSON.stringify(data, null, 2));

        // 2. Identify the type of event and create a Discord embed message
        let embed = {};

        // If it looks like a receipt
        if (data.receipt_number || data.receipts) {
            const receipts = data.receipts || [data];
            
            for (const receipt of receipts) {
                const total = receipt.total_money || 0;
                const items = receipt.line_items || [];
                
                // Format the items list
                let itemsDescription = items.map(item => {
                    return `- **${item.quantity || 1}x ${item.item_name || 'Unknown Item'}** (฿${item.total_money || 0})`;
                }).join('\n');

                if (itemsDescription.length === 0) {
                    itemsDescription = 'No items found in receipt.';
                }

                embed = {
                    title: `🧾 New Receipt: #${receipt.receipt_number || 'N/A'}`,
                    color: 0x00FF00, // Green
                    description: `A new order has been completed!\n\n**Items:**\n${itemsDescription}`,
                    fields: [
                        {
                            name: 'Total Amount',
                            value: `฿${total}`,
                            inline: true
                        }
                    ],
                    timestamp: receipt.created_at || new Date().toISOString()
                };

                await sendToDiscord(embed);
            }
        } 
        // If it looks like an inventory update
        else if (data.inventory || data.items) {
             const updates = data.inventory || data.items || [];
             let stockChanges = updates.map(update => {
                 return `- ${update.item_name || 'Item ID ' + update.item_id}: In Stock = **${update.in_stock || 0}**`;
             }).join('\n');

             if (updates.length > 0) {
                 embed = {
                     title: `📦 Inventory Update`,
                     color: 0xFFA500, // Orange
                     description: `Stock levels have been updated.\n\n${stockChanges}`,
                     timestamp: new Date().toISOString()
                 };
                 await sendToDiscord(embed);
             }
        }
        else {
             // Generic fallback
             embed = {
                 title: `🔔 Loyverse Notification`,
                 color: 0x3498DB, // Blue
                 description: 'Received an unknown event type.',
                 timestamp: new Date().toISOString()
             };
             await sendToDiscord(embed);
        }

        res.status(200).send('Webhook received and processed');
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Endpoint to trigger the daily summary manually for today
app.get('/test-summary', async (req, res) => {
    await sendDailySummary();
    res.send('Summary triggered! Check your Discord.');
});

// Endpoint to request a summary for a specific past date
app.get('/summary', async (req, res) => {
    const dateParam = req.query.date;
    if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        return res.status(400).send('กรุณาระบุวันที่ในรูปแบบ YYYY-MM-DD เช่น /summary?date=2026-06-30');
    }
    await sendDailySummary(dateParam);
    res.send(`ดึงข้อมูลสรุปยอดขายของวันที่ ${dateParam} สำเร็จ! กรุณาตรวจสอบใน Discord ครับ`);
});

// Function to send the message to Discord
async function sendToDiscord(embed) {
    if (!DISCORD_WEBHOOK_URL) {
        console.error('Discord webhook URL is not configured!');
        return;
    }

    const payload = {
        embeds: [embed]
    };

    try {
        const fetchResponse = await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!fetchResponse.ok) {
            console.error('Failed to send message to Discord:', fetchResponse.statusText);
        } else {
            console.log('Successfully sent message to Discord!');
        }
    } catch (err) {
        console.error('Network error when sending to Discord:', err);
    }
}

// ------------------------------------------------------------------
// Daily Summary Cron Job
// ------------------------------------------------------------------

// Schedule the task at 23:00 (11 PM) every day in Bangkok time
cron.schedule('0 23 * * *', async () => {
    console.log('Running daily sales summary task (11 PM)...');
    await sendDailySummary();
}, {
    scheduled: true,
    timezone: "Asia/Bangkok"
});

async function sendDailySummary(dateString = null) {
    try {
        if (!LOYVERSE_ACCESS_TOKEN) {
            console.error('Loyverse Access Token not configured for daily summary');
            return;
        }

        // Determine target date in Bangkok timezone
        let targetDate;
        if (dateString) {
            targetDate = DateTime.fromISO(dateString, { zone: 'Asia/Bangkok' });
        } else {
            targetDate = DateTime.now().setZone('Asia/Bangkok');
        }

        const startOfDay = targetDate.startOf('day').toUTC().toISO();
        const endOfDay = targetDate.endOf('day').toUTC().toISO();

        console.log(`Fetching receipts from ${startOfDay} to ${endOfDay}`);

        // Fetch receipts from Loyverse
        const response = await axios.get('https://api.loyverse.com/v1.0/receipts', {
            params: {
                created_at_min: startOfDay,
                created_at_max: endOfDay,
                limit: 250 // You can implement pagination here if you have >250 receipts/day
            },
            headers: {
                'Authorization': `Bearer ${LOYVERSE_ACCESS_TOKEN}`
            }
        });

        const receipts = response.data.receipts || [];
        
        let totalRevenue = 0;
        let totalReceipts = receipts.length;
        let totalItemsSold = 0;
        let itemCounts = {};
        
        receipts.forEach(receipt => {
            totalRevenue += (receipt.total_money || 0);
            const items = receipt.line_items || [];
            items.forEach(item => {
                const qty = item.quantity || 1;
                const name = item.item_name || 'Unknown Item';
                totalItemsSold += qty;
                
                if (itemCounts[name]) {
                    itemCounts[name] += qty;
                } else {
                    itemCounts[name] = qty;
                }
            });
        });

        // Format items list
        // Sort items by quantity (highest first)
        const sortedItems = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]);
        let itemsListString = sortedItems.map(([name, qty]) => `- ${name}: ${qty} ชิ้น`).join('\n');
        
        if (itemsListString.length === 0) {
            itemsListString = '- ไม่มีสินค้าที่ขายได้เลย';
        } else if (itemsListString.length > 2048) {
            // Discord embed description limit is 4096, but keep it safe
            itemsListString = itemsListString.substring(0, 2000) + '\n... (รายการยาวเกินไป)';
        }

        // Create Discord embed for Daily Summary
        const embed = {
            title: `📊 สรุปยอดขายประจำวัน - ${targetDate.toFormat('dd/MM/yyyy')}`,
            color: 0x9B59B6, // Purple
            description: `**รายการสินค้าที่ขายได้วันนี้:**\n${itemsListString}`,
            fields: [
                {
                    name: 'ยอดขายรวม (Total Revenue)',
                    value: `฿${totalRevenue.toFixed(2)}`,
                    inline: true
                },
                {
                    name: 'จำนวนบิล (Receipts)',
                    value: `${totalReceipts} บิล`,
                    inline: true
                },
                {
                    name: 'รวมจำนวนชิ้น (Items)',
                    value: `${totalItemsSold} ชิ้น`,
                    inline: true
                }
            ],
            timestamp: new Date().toISOString()
        };

        await sendToDiscord(embed);
        console.log('Daily summary sent successfully.');

    } catch (error) {
        console.error('Error fetching daily summary:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
        }
    }
}

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
