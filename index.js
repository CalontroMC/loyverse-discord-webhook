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

// Endpoint to request a summary for a specific month
app.get('/monthly', async (req, res) => {
    const monthParam = req.query.month;
    if (!monthParam || !/^\d{4}-\d{2}$/.test(monthParam)) {
        return res.status(400).send('กรุณาระบุเดือนในรูปแบบ YYYY-MM เช่น /monthly?month=2026-06');
    }
    
    // We don't await this so the browser returns immediately, preventing timeout
    sendMonthlySummary(monthParam).catch(err => console.error(err));
    res.send(`ระบบกำลังดึงข้อมูลสรุปยอดขายของเดือน ${monthParam} (อาจใช้เวลาสักครู่หากมีบิลเยอะ) กรุณารอข้อความเด้งใน Discord ครับ`);
});

// Endpoint to keep the server awake (for cron-job.org)
app.get('/ping', (req, res) => {
    res.status(200).send('Pong!');
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

async function sendSummaryToDiscord(title, color, descriptionPrefix, sortedItems, fields) {
    const MAX_EMBED_DESC = 3000;
    
    // Chunk the sortedItems into strings of max 3000 chars
    let chunks = [];
    let currentChunk = "";
    
    sortedItems.forEach(([name, qty]) => {
        const line = `- ${name}: ${qty} ชิ้น\n`;
        if (currentChunk.length + line.length > MAX_EMBED_DESC) {
            chunks.push(currentChunk);
            currentChunk = line;
        } else {
            currentChunk += line;
        }
    });
    if (currentChunk) {
        chunks.push(currentChunk);
    }
    
    if (chunks.length === 0) {
        chunks = ['- ไม่มีสินค้าที่ขายได้เลย'];
    }
    
    for (let i = 0; i < chunks.length; i++) {
        const isFirst = (i === 0);
        
        const embed = {
            title: isFirst ? title : `${title} (ต่อส่วนที่ ${i+1}/${chunks.length})`,
            color: color,
            description: isFirst ? `${descriptionPrefix}\n${chunks[i]}` : chunks[i],
            timestamp: new Date().toISOString()
        };
        
        // Only attach fields (Revenue, etc.) to the FIRST message
        if (isFirst && fields) {
            embed.fields = fields;
        }
        
        await sendToDiscord(embed);
        
        // Add a small delay between messages to avoid Discord rate limit
        if (chunks.length > 1) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

// Schedule the task at 23:00 (11 PM) every day in Bangkok time
cron.schedule('0 23 * * *', async () => {
    console.log('Running daily sales summary task (11 PM)...');
    await sendDailySummary();
}, {
    scheduled: true,
    timezone: "Asia/Bangkok"
});

async function fetchAllReceipts(startIso, endIso) {
    let allReceipts = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
        const params = {
            created_at_min: startIso,
            created_at_max: endIso,
            limit: 250
        };
        if (cursor) {
            params.cursor = cursor;
        }

        const response = await axios.get('https://api.loyverse.com/v1.0/receipts', {
            params: params,
            headers: {
                'Authorization': `Bearer ${LOYVERSE_ACCESS_TOKEN}`
            }
        });

        const receipts = response.data.receipts || [];
        allReceipts = allReceipts.concat(receipts);

        if (response.data.cursor) {
            cursor = response.data.cursor;
        } else {
            hasMore = false;
        }
    }
    return allReceipts;
}

async function fetchAllShifts(startIso, endIso) {
    let allShifts = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
        const params = {
            opened_at_min: startIso,
            opened_at_max: endIso,
            limit: 250
        };
        if (cursor) {
            params.cursor = cursor;
        }

        const response = await axios.get('https://api.loyverse.com/v1.0/shifts', {
            params: params,
            headers: {
                'Authorization': `Bearer ${LOYVERSE_ACCESS_TOKEN}`
            }
        });

        const shifts = response.data.shifts || [];
        allShifts = allShifts.concat(shifts);

        if (response.data.cursor) {
            cursor = response.data.cursor;
        } else {
            hasMore = false;
        }
    }
    return allShifts;
}

async function sendMonthlySummary(monthString) {
    try {
        if (!LOYVERSE_ACCESS_TOKEN) {
            console.error('Loyverse Access Token not configured for monthly summary');
            return;
        }

        const targetDate = DateTime.fromISO(`${monthString}-01`, { zone: 'Asia/Bangkok' });
        if (!targetDate.isValid) {
            console.error('Invalid month provided:', monthString);
            return;
        }

        const startOfMonth = targetDate.startOf('month').toUTC().toISO();
        const endOfMonth = targetDate.endOf('month').toUTC().toISO();

        console.log(`Fetching monthly receipts from ${startOfMonth} to ${endOfMonth}`);
        const receipts = await fetchAllReceipts(startOfMonth, endOfMonth);

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

        const sortedItems = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]);
        const title = `📅 สรุปยอดขายประจำเดือน - ${targetDate.toFormat('MM/yyyy')}`;
        const descriptionPrefix = `**สรุปรายการสินค้าที่ขายได้ตลอดทั้งเดือน:**`;
        const fields = [
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
        ];

        await sendSummaryToDiscord(title, 0x3498DB, descriptionPrefix, sortedItems, fields);

    } catch (error) {
        console.error('Error generating monthly summary:', error.message);
    }
}

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
        const receipts = await fetchAllReceipts(startOfDay, endOfDay);
        
        console.log(`Fetching shifts from ${startOfDay} to ${endOfDay}`);
        const shifts = await fetchAllShifts(startOfDay, endOfDay);
        
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

        // Calculate cash management data from shifts
        let totalOpeningCash = 0;
        let totalPayIns = 0;
        let totalPayOuts = 0;
        let totalExpectedCash = 0;
        let totalActualCash = 0;

        shifts.forEach(shift => {
            totalOpeningCash += (shift.opening_amount || 0);
            totalPayIns += (shift.pay_ins || 0);
            totalPayOuts += (shift.pay_outs || 0);
            totalExpectedCash += (shift.expected_amount || 0);
            totalActualCash += (shift.actual_amount || 0);
        });

        const sortedItems = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]);
        const title = `📊 สรุปยอดขายและเงินสดประจำวัน - ${targetDate.toFormat('dd/MM/yyyy')}`;
        const descriptionPrefix = `**รายการสินค้าที่ขายได้วันนี้:**`;
        const fields = [
            {
                name: 'ยอดขายรวม',
                value: `฿${totalRevenue.toFixed(2)}`,
                inline: true
            },
            {
                name: 'จำนวนบิล',
                value: `${totalReceipts} บิล`,
                inline: true
            },
            {
                name: 'รวมจำนวนชิ้น',
                value: `${totalItemsSold} ชิ้น`,
                inline: true
            },
            {
                name: 'เงินทอนเริ่มต้น',
                value: `฿${totalOpeningCash.toFixed(2)}`,
                inline: true
            },
            {
                name: 'นำเงินเข้า (Pay In)',
                value: `฿${totalPayIns.toFixed(2)}`,
                inline: true
            },
            {
                name: 'นำเงินออก (Pay Out)',
                value: `฿${totalPayOuts.toFixed(2)}`,
                inline: true
            },
            {
                name: 'เงินสดที่คาดหวัง',
                value: `฿${totalExpectedCash.toFixed(2)}`,
                inline: true
            },
            {
                name: 'เงินสดตรวจนับจริง',
                value: `฿${totalActualCash.toFixed(2)}`,
                inline: true
            },
            {
                name: 'ส่วนต่างเงินสด',
                value: `฿${(totalActualCash - totalExpectedCash).toFixed(2)}`,
                inline: true
            }
        ];

        await sendSummaryToDiscord(title, 0x9B59B6, descriptionPrefix, sortedItems, fields);
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
