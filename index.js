require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const cron = require("node-cron");
const axios = require("axios");
const { DateTime } = require("luxon");

const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");

const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY
  ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
  : null;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

let lastSheetError = null;
let googleServiceAccountAuth = null;
if (GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_PRIVATE_KEY) {
  googleServiceAccountAuth = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

const app = express();
const port = process.env.PORT || 3000;

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const LOYVERSE_SECRET = process.env.LOYVERSE_WEBHOOK_SECRET;
const LOYVERSE_ACCESS_TOKEN = process.env.LOYVERSE_ACCESS_TOKEN;

// Middleware to parse JSON and keep the raw body for signature verification
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Store recently processed receipt numbers to prevent duplicate notifications
const processedReceipts = new Map();

// Webhook endpoint for real-time events
app.post("/webhook/loyverse", async (req, res) => {
  try {
    // 1. Verify Signature
    const signature = req.headers["x-loyverse-signature"];
    if (signature) {
      const hmac = crypto.createHmac("sha1", LOYVERSE_SECRET);
      const digest = hmac.update(req.rawBody).digest("base64");

      if (signature !== digest) {
        console.error("Invalid signature.", {
          expected: digest,
          received: signature,
        });
        return res.status(401).send("Invalid signature");
      }
    } else {
      console.warn(
        "No signature provided in the headers. Proceeding anyway for testing."
      );
      // In a strict environment, you would return 401 here.
    }

    // 2. Respond immediately to Loyverse to prevent webhook timeouts
    res.status(200).send("Webhook received and processing in background");

    const data = req.body || {};
    console.log("Received webhook data:", JSON.stringify(data, null, 2));

    // 3. Process the event in the background (Async)
    (async () => {
      let embed = {};

      // If it looks like a receipt
      if (data.receipt_number || data.receipts) {
        const receipts = data.receipts || [data];

        for (const receipt of receipts) {
          const receiptNum = receipt.receipt_number;

          // Deduplication logic
          if (receiptNum) {
            if (processedReceipts.has(receiptNum)) {
              console.log(
                `Skipping duplicate webhook for receipt: ${receiptNum}`
              );
              continue;
            }
            processedReceipts.set(receiptNum, Date.now());

            // Cleanup cache (remove items older than 15 mins)
            for (const [key, timestamp] of processedReceipts.entries()) {
              if (Date.now() - timestamp > 15 * 60 * 1000) {
                processedReceipts.delete(key);
              }
            }
          }

          const total = receipt.total_money || 0;
          const items = receipt.line_items || [];
          const isRefund = receipt.receipt_type === "REFUND" || total < 0;
          const totalDiscount = receipt.total_discount || 0;
          const payments = receipt.payments || [];

          // Send to Google Sheets (Fire and forget)

          // Format the items list
          let itemsDescription = items
            .map((item) => {
              return `- **${item.quantity || 1}x ${
                item.item_name || "Unknown Item"
              }** (฿${item.total_money || 0})`;
            })
            .join("\n");

          if (itemsDescription.length === 0) {
            itemsDescription = "No items found in receipt.";
          }

          // Format Payment Methods
          let paymentsDescription = "";
          if (payments.length > 0) {
            paymentsDescription =
              "\n\n**💳 ชำระผ่าน:**\n" +
              payments
                .map((p) => `- ${p.name || "Unknown"}: ฿${p.money_amount || 0}`)
                .join("\n");
          }

          // Format Discounts
          let discountDescription = "";
          if (totalDiscount > 0) {
            discountDescription = `\n\n**⚠️ ส่วนลด:** ให้ส่วนลด ฿${totalDiscount}`;
          } else if (totalDiscount < 0) {
            discountDescription = `\n\n**⚠️ ส่วนลด:** ให้ส่วนลด ฿${Math.abs(
              totalDiscount
            )}`;
          }

          embed = {
            title: isRefund
              ? `🚨 แจ้งเตือน: มีการยกเลิกบิล/คืนเงิน (#${
                  receipt.receipt_number || "N/A"
                })`
              : `🧾 บิลใหม่: #${receipt.receipt_number || "N/A"}`,
            color: isRefund ? 0xff0000 : 0x00ff00, // Red for refund, Green for sale
            description: `A new order has been completed!\n\n**Items:**\n${itemsDescription}${discountDescription}${paymentsDescription}`,
            fields: [
              {
                name: "ยอดสุทธิ (Total Amount)",
                value: `฿${total}`,
                inline: true,
              },
            ],
            timestamp: receipt.created_at || new Date().toISOString(),
          };

          await sendToDiscord(embed);
        }
      }
      // If it looks like an inventory update
      else if (data.inventory || data.items) {
        const updates = data.inventory || data.items || [];
        let stockChanges = updates
          .map((update) => {
            return `- ${
              update.item_name || "Item ID " + update.item_id
            }: In Stock = **${update.in_stock || 0}**`;
          })
          .join("\n");

        if (updates.length > 0) {
          embed = {
            title: `📦 Inventory Update`,
            color: 0xffa500, // Orange
            description: `Stock levels have been updated.\n\n${stockChanges}`,
            timestamp: new Date().toISOString(),
          };
          await sendToDiscord(embed);
        }
      } else {
        // Generic fallback
        embed = {
          title: `🔔 Loyverse Notification`,
          color: 0x3498db, // Blue
          description: "Received an unknown event type.",
          timestamp: new Date().toISOString(),
        };
        await sendToDiscord(embed);
      }
    })().catch((err) => {
      console.error("Error in background processing:", err);
    });
  } catch (error) {
    console.error("Error processing webhook:", error);
    // Only send error if we haven't already sent a response
    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    }
  }
});

// Endpoint to trigger the daily summary manually for today
app.get("/test-summary", async (req, res) => {
  await sendDailySummary();
  res.send("Summary triggered! Check your Discord.");
});

// Endpoint to request a summary for a specific date
app.get("/summary", async (req, res) => {
  const dateParam = req.query.date;
  if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return res
      .status(400)
      .send("กรุณาระบุวันที่ในรูปแบบ YYYY-MM-DD เช่น /summary?date=2026-07-01");
  }

  // We don't await this so the browser returns immediately
  sendDailySummary(dateParam).catch((err) => console.error(err));
  res.send(
    `ระบบกำลังดึงข้อมูลสรุปยอดขายของวันที่ ${dateParam} (อาจใช้เวลาสักครู่) กรุณารอข้อความเด้งใน Discord ครับ`
  );
});

// Endpoint to request a summary for a specific month
app.get("/monthly", async (req, res) => {
  const monthParam = req.query.month;
  if (!monthParam || !/^\d{4}-\d{2}$/.test(monthParam)) {
    return res
      .status(400)
      .send("กรุณาระบุเดือนในรูปแบบ YYYY-MM เช่น /monthly?month=2026-06");
  }

  // We don't await this so the browser returns immediately, preventing timeout
  sendMonthlySummary(monthParam).catch((err) => console.error(err));
  res.send(
    `ระบบกำลังดึงข้อมูลสรุปยอดขายของเดือน ${monthParam} (อาจใช้เวลาสักครู่หากมีบิลเยอะ) กรุณารอข้อความเด้งใน Discord ครับ`
  );
});

// Endpoint to keep the server awake (for cron-job.org)

// Expose debug endpoint
app.get("/debug-sheet", (req, res) => {
  res.json({
    hasAuth: !!googleServiceAccountAuth,
    sheetId: GOOGLE_SHEET_ID,
    lastError: lastSheetError,
  });
});

app.get("/ping", (req, res) => {
  res.status(200).send("Pong!");
});

// Cached Data for Webhooks
let cachedCategories = null;
let cachedItems = null;
let lastCacheUpdate = 0;

async function getCachedMaps() {
  if (
    !cachedCategories ||
    !cachedItems ||
    Date.now() - lastCacheUpdate > 60 * 60 * 1000
  ) {
    cachedCategories = await fetchAllCategories();
    cachedItems = await fetchAllItems();
    lastCacheUpdate = Date.now();
  }
  return { categories: cachedCategories, items: cachedItems };
}

async function appendDailySummaryToGoogleSheet(summaryData) {
  if (!GOOGLE_SHEET_ID || !googleServiceAccountAuth) {
    console.log("Google Sheets integration is not fully configured.");
    return;
  }
  try {
    const doc = new GoogleSpreadsheet(
      GOOGLE_SHEET_ID,
      googleServiceAccountAuth
    );
    await doc.loadInfo();

    let sheet = doc.sheetsByTitle[summaryData.dateStr];
    if (!sheet) {
      sheet = await doc.addSheet({
        title: summaryData.dateStr,
        headerValues: ["หัวข้อ", "ข้อมูล"],
      });
    } else {
      await sheet.clear();
      await sheet.setHeaderRow(["หัวข้อ", "ข้อมูล"]);
    }

    const rowsToAdd = [
      ["วันที่", summaryData.dateStr],
      ["ยอดขายรวม", summaryData.totalRevenue + " บาท"],
      ["จำนวนบิล", summaryData.totalReceipts + " บิล"],
      ["จำนวนสินค้าที่ขาย", summaryData.totalItemsSold + " ชิ้น"],
      ["เงินทอนเริ่มต้น", summaryData.totalOpeningCash + " บาท"],
      ["นำเงินเข้า (Pay In)", summaryData.totalPayIns + " บาท"],
      ["นำเงินออก (Pay Out)", summaryData.totalPayOuts + " บาท"],
      ["เงินสดที่คาดหวัง", summaryData.totalExpectedCash + " บาท"],
      ["เงินสดตรวจนับจริง", summaryData.totalActualCash + " บาท"],
      ["ส่วนต่างเงินสด", summaryData.difference + " บาท"],
      ["", ""],
      ["ยอดขายแยกตามหมวดหมู่", ""],
    ];

    // Add Categories
    const sortedCats = Object.keys(summaryData.groupedItems).sort();
    sortedCats.forEach((cat) => {
      const itemsInCat = summaryData.groupedItems[cat];
      let catTotalQty = 0;
      let catTotalMoney = 0;
      itemsInCat.forEach((i) => {
        catTotalQty += i.qty;
        catTotalMoney += i.money;
      });
      rowsToAdd.push([cat, `${catTotalMoney} บาท (${catTotalQty} ชิ้น)`]);
    });

    rowsToAdd.push(["", ""]);
    rowsToAdd.push(["รายการเมนูที่ขายได้ (เรียงตามยอดขาย)", ""]);

    // Add Top Items
    summaryData.allItemsArray.forEach((item) => {
      rowsToAdd.push([item.name, `${item.money} บาท (${item.qty} ชิ้น)`]);
    });

    await sheet.addRows(rowsToAdd);
    console.log("Successfully created daily report on Google Sheets.");
  } catch (e) {
    lastSheetError = e.message;
    console.error("Error appending to Google Sheet:", e.stack);
  }
}

// Function to send the message to Discord
async function sendToDiscord(embed) {
  if (!DISCORD_WEBHOOK_URL) {
    console.error("Discord webhook URL is not configured!");
    return;
  }

  const payload = {
    embeds: [embed],
  };

  try {
    const fetchResponse = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!fetchResponse.ok) {
      console.error(
        "Failed to send message to Discord:",
        fetchResponse.statusText
      );
    } else {
      console.log("Successfully sent message to Discord!");
    }
  } catch (err) {
    console.error("Network error when sending to Discord:", err);
  }
}

// ------------------------------------------------------------------
// Daily Summary Cron Job
// ------------------------------------------------------------------

async function sendSummaryToDiscord(
  title,
  color,
  descriptionPrefix,
  formattedLines,
  fields,
  imageUrl = null
) {
  const MAX_EMBED_DESC = 3000;

  // Chunk the formattedLines into strings of max 3000 chars
  let chunks = [];
  let currentChunk = "";

  formattedLines.forEach((line) => {
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
    chunks = ["- ไม่มีสินค้าที่ขายได้เลย"];
  }

  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;

    const embed = {
      title: isFirst
        ? title
        : `${title} (ต่อส่วนที่ ${i + 1}/${chunks.length})`,
      color: color,
      description: isFirst ? `${descriptionPrefix}\n${chunks[i]}` : chunks[i],
      timestamp: new Date().toISOString(),
    };

    // Only attach fields (Revenue, etc.) to the FIRST message
    if (isFirst && fields) {
      embed.fields = fields;
    }

    // Only attach the chart image to the FIRST message
    if (isFirst && imageUrl) {
      embed.image = { url: imageUrl };
    }

    await sendToDiscord(embed);

    // Add a small delay between messages to avoid Discord rate limit
    if (chunks.length > 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// Schedule the task at 23:00 (11 PM) every day in Bangkok time
// Internal cron removed; relying on external cron-job.org triggering /test-summary

async function fetchAllReceipts(startIso, endIso) {
  let allReceipts = [];
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    const params = {
      created_at_min: startIso,
      created_at_max: endIso,
      limit: 250,
    };
    if (cursor) {
      params.cursor = cursor;
    }

    const response = await axios.get("https://api.loyverse.com/v1.0/receipts", {
      params: params,
      headers: {
        Authorization: `Bearer ${LOYVERSE_ACCESS_TOKEN}`,
      },
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
      created_at_min: startIso,
      created_at_max: endIso,
      limit: 250,
    };
    if (cursor) {
      params.cursor = cursor;
    }

    const response = await axios.get("https://api.loyverse.com/v1.0/shifts", {
      params: params,
      headers: {
        Authorization: `Bearer ${LOYVERSE_ACCESS_TOKEN}`,
      },
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

async function fetchAllCategories() {
  let allCategories = [];
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    const params = { limit: 250 };
    if (cursor) params.cursor = cursor;

    const response = await axios.get(
      "https://api.loyverse.com/v1.0/categories",
      {
        params: params,
        headers: { Authorization: `Bearer ${LOYVERSE_ACCESS_TOKEN}` },
      }
    );

    const categories = response.data.categories || [];
    allCategories = allCategories.concat(categories);

    if (response.data.cursor) cursor = response.data.cursor;
    else hasMore = false;
  }

  const categoryMap = {};
  allCategories.forEach((c) => (categoryMap[c.id] = c.name));
  return categoryMap;
}

async function fetchAllItems() {
  let allItems = [];
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    const params = { limit: 250 };
    if (cursor) params.cursor = cursor;

    const response = await axios.get("https://api.loyverse.com/v1.0/items", {
      params: params,
      headers: { Authorization: `Bearer ${LOYVERSE_ACCESS_TOKEN}` },
    });

    const items = response.data.items || [];
    allItems = allItems.concat(items);

    if (response.data.cursor) cursor = response.data.cursor;
    else hasMore = false;
  }

  const itemCategoryMap = {};
  allItems.forEach((i) => (itemCategoryMap[i.id] = i.category_id));
  return itemCategoryMap;
}

async function sendMonthlySummary(monthString) {
  try {
    if (!LOYVERSE_ACCESS_TOKEN) {
      console.error("Loyverse Access Token not configured for monthly summary");
      return;
    }

    const targetDate = DateTime.fromISO(`${monthString}-01`, {
      zone: "Asia/Bangkok",
    });
    if (!targetDate.isValid) {
      console.error("Invalid month provided:", monthString);
      return;
    }

    const startOfMonth = targetDate.startOf("month").toUTC().toISO();
    const endOfMonth = targetDate.endOf("month").toUTC().toISO();

    console.log(
      `Fetching monthly receipts from ${startOfMonth} to ${endOfMonth}`
    );
    const receipts = await fetchAllReceipts(startOfMonth, endOfMonth);
    const categoryMap = await fetchAllCategories();
    const itemCategoryMap = await fetchAllItems();

    let totalRevenue = 0;
    let totalReceipts = receipts.length;
    let totalItemsSold = 0;
    let itemStats = {}; // { [itemId]: { name, qty, catName } }

    receipts.forEach((receipt) => {
      totalRevenue += receipt.total_money || 0;
      const items = receipt.line_items || [];
      items.forEach((item) => {
        const qty = item.quantity || 1;
        const name = item.item_name || "Unknown Item";
        const itemId = item.item_id;
        totalItemsSold += qty;

        const catId = itemCategoryMap[itemId];
        const catName =
          catId && categoryMap[catId] ? categoryMap[catId] : "ไม่มีหมวดหมู่";

        if (!itemStats[itemId]) {
          itemStats[itemId] = {
            name: name,
            qty: 0,
            money: 0,
            catName: catName,
          };
        }
        itemStats[itemId].qty += qty;
        itemStats[itemId].money += item.total_money || 0;
      });
    });

    // Group by Category
    const groupedItems = {};
    Object.values(itemStats).forEach((stat) => {
      if (!groupedItems[stat.catName]) groupedItems[stat.catName] = [];
      groupedItems[stat.catName].push(stat);
    });

    // Format lines for Discord
    const formattedLines = [];
    const sortedCats = Object.keys(groupedItems).sort();
    sortedCats.forEach((cat) => {
      formattedLines.push(`**📂 ${cat}**\n`);
      const itemsInCat = groupedItems[cat].sort((a, b) => b.qty - a.qty);
      itemsInCat.forEach((i) => {
        formattedLines.push(`- ${i.name}: ${i.qty} ชิ้น\n`);
      });
      formattedLines.push(`\n`);
    });

    // For Chart and Sheets: overall items
    const allItemsArray = Object.values(itemStats).sort(
      (a, b) => b.money - a.money
    );

    // -------------------------
    // Monthly Target Progress
    // -------------------------
    const MONTHLY_TARGET = 100000; // Default target 100,000 THB
    // Ensure progress is between 0 and 100
    let progressPercentage = Math.max(
      0,
      Math.min(Math.round((totalRevenue / MONTHLY_TARGET) * 100), 100)
    );
    let filledBars = Math.floor(progressPercentage / 10);
    let emptyBars = Math.max(0, 10 - filledBars);
    let progressBar = `[${"█".repeat(filledBars)}${"░".repeat(
      emptyBars
    )}] ${progressPercentage}%`;
    let targetText = `เป้าหมาย: ฿${MONTHLY_TARGET.toLocaleString()} \n`;
    if (totalRevenue >= MONTHLY_TARGET) {
      targetText += `🎉 ยินดีด้วย! ยอดขายทะลุเป้าหมายแล้ว!`;
    } else {
      let remaining = MONTHLY_TARGET - totalRevenue;
      targetText += `(ขาดอีก ฿${remaining.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} จะถึงเป้า)`;
    }

    const title = `📅 สรุปยอดขายประจำเดือน - ${targetDate.toFormat("MM/yyyy")}`;
    const descriptionPrefix = `**เป้าหมายยอดขายประจำเดือน 🎯**\n${progressBar}\n${targetText}\n\n**สรุปรายการสินค้าที่ขายได้ตลอดทั้งเดือน:**`;
    const fields = [
      {
        name: "ยอดขายรวม (Total Revenue)",
        value: `฿${totalRevenue.toFixed(2)}`,
        inline: true,
      },
      {
        name: "จำนวนบิล (Receipts)",
        value: `${totalReceipts} บิล`,
        inline: true,
      },
      {
        name: "รวมจำนวนชิ้น (Items)",
        value: `${totalItemsSold} ชิ้น`,
        inline: true,
      },
    ];

    // Generate Bar Chart URL for top 10 items
    let chartUrl = null;
    if (allItemsArray.length > 0) {
      const topItems = allItemsArray.slice(0, 10);
      const chartConfig = {
        type: "bar",
        data: {
          labels: topItems.map((i) =>
            i.name.length > 15 ? i.name.substring(0, 15) + "..." : i.name
          ), // Truncate long names
          datasets: [
            {
              label: "ขายได้ (ชิ้น)",
              data: topItems.map((i) => i.qty),
              backgroundColor: "rgba(54, 162, 235, 0.6)",
              borderColor: "rgb(54, 162, 235)",
              borderWidth: 1,
            },
          ],
        },
        options: {
          plugins: {
            legend: { display: false },
            title: { display: true, text: "Top 10 สินค้าขายดีประจำเดือน" },
          },
        },
      };
      chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(
        JSON.stringify(chartConfig)
      )}`;
    }

    await sendSummaryToDiscord(
      title,
      0x3498db,
      descriptionPrefix,
      formattedLines,
      fields,
      chartUrl
    );
  } catch (error) {
    console.error("Error generating monthly summary:", error.message);
  }
}

async function sendDailySummary(dateString = null) {
  try {
    if (!LOYVERSE_ACCESS_TOKEN) {
      console.error("Loyverse Access Token not configured for daily summary");
      return;
    }

    // Determine target date in Bangkok timezone
    let targetDate;
    if (dateString) {
      targetDate = DateTime.fromISO(dateString, { zone: "Asia/Bangkok" });
    } else {
      targetDate = DateTime.now().setZone("Asia/Bangkok");
    }

    const startOfDay = targetDate.startOf("day").toUTC().toISO();
    const endOfDay = targetDate.endOf("day").toUTC().toISO();

    console.log(`Fetching receipts from ${startOfDay} to ${endOfDay}`);
    const receipts = await fetchAllReceipts(startOfDay, endOfDay);

    console.log(`Fetching shifts from ${startOfDay} to ${endOfDay}`);
    const shifts = await fetchAllShifts(startOfDay, endOfDay);

    const categoryMap = await fetchAllCategories();
    const itemCategoryMap = await fetchAllItems();

    let totalRevenue = 0;
    let totalReceipts = receipts.length;
    let totalItemsSold = 0;
    let itemStats = {};

    receipts.forEach((receipt) => {
      totalRevenue += receipt.total_money || 0;
      const items = receipt.line_items || [];
      items.forEach((item) => {
        const qty = item.quantity || 1;
        const name = item.item_name || "Unknown Item";
        const itemId = item.item_id;
        totalItemsSold += qty;

        const catId = itemCategoryMap[itemId];
        const catName =
          catId && categoryMap[catId] ? categoryMap[catId] : "ไม่มีหมวดหมู่";

        if (!itemStats[itemId]) {
          itemStats[itemId] = {
            name: name,
            qty: 0,
            money: 0,
            catName: catName,
          };
        }
        itemStats[itemId].qty += qty;
        itemStats[itemId].money += item.total_money || 0;
      });
    });

    // Group by Category
    const groupedItems = {};
    Object.values(itemStats).forEach((stat) => {
      if (!groupedItems[stat.catName]) groupedItems[stat.catName] = [];
      groupedItems[stat.catName].push(stat);
    });

    // Format lines for Discord
    const formattedLines = [];
    const sortedCats = Object.keys(groupedItems).sort();
    sortedCats.forEach((cat) => {
      formattedLines.push(`**📂 ${cat}**\n`);
      const itemsInCat = groupedItems[cat].sort((a, b) => b.qty - a.qty);
      itemsInCat.forEach((i) => {
        formattedLines.push(`- ${i.name}: ${i.qty} ชิ้น\n`);
      });
      formattedLines.push(`\n`);
    });

    // For Chart: overall top 10 items
    const allItemsArray = Object.values(itemStats).sort(
      (a, b) => b.qty - a.qty
    );

    // Calculate cash management data from shifts
    let totalOpeningCash = 0;
    let totalPayIns = 0;
    let totalPayOuts = 0;
    let totalExpectedCash = 0;
    let totalActualCash = 0;

    shifts.forEach((shift) => {
      totalOpeningCash += shift.starting_cash || 0;
      totalPayIns += shift.paid_in || 0;
      totalPayOuts += shift.paid_out || 0;
      totalExpectedCash += shift.expected_cash || 0;
      totalActualCash += shift.actual_cash || 0;
    });

    const title = `📊 สรุปยอดขายและเงินสดประจำวัน - ${targetDate.toFormat(
      "dd/MM/yyyy"
    )}`;
    const descriptionPrefix = `**รายการสินค้าที่ขายได้วันนี้:**`;
    const fields = [
      {
        name: "ยอดขายรวม",
        value: `฿${totalRevenue.toFixed(2)}`,
        inline: true,
      },
      {
        name: "จำนวนบิล",
        value: `${totalReceipts} บิล`,
        inline: true,
      },
      {
        name: "รวมจำนวนชิ้น",
        value: `${totalItemsSold} ชิ้น`,
        inline: true,
      },
      {
        name: "เงินทอนเริ่มต้น",
        value: `฿${totalOpeningCash.toFixed(2)}`,
        inline: true,
      },
      {
        name: "นำเงินเข้า (Pay In)",
        value: `฿${totalPayIns.toFixed(2)}`,
        inline: true,
      },
      {
        name: "นำเงินออก (Pay Out)",
        value: `฿${totalPayOuts.toFixed(2)}`,
        inline: true,
      },
      {
        name: "เงินสดที่คาดหวัง",
        value: `฿${totalExpectedCash.toFixed(2)}`,
        inline: true,
      },
      {
        name: "เงินสดตรวจนับจริง",
        value: `฿${totalActualCash.toFixed(2)}`,
        inline: true,
      },
      {
        name: "ส่วนต่างเงินสด",
        value: `฿${(totalActualCash - totalExpectedCash).toFixed(2)}`,
        inline: true,
      },
    ];

    // Generate Bar Chart URL for top 10 items
    let chartUrl = null;
    if (allItemsArray.length > 0) {
      const topItems = allItemsArray.slice(0, 10);
      const chartConfig = {
        type: "bar",
        data: {
          labels: topItems.map((i) =>
            i.name.length > 15 ? i.name.substring(0, 15) + "..." : i.name
          ),
          datasets: [
            {
              label: "ขายได้ (ชิ้น)",
              data: topItems.map((i) => i.qty),
              backgroundColor: "rgba(155, 89, 182, 0.6)", // Purple to match embed color
              borderColor: "rgb(155, 89, 182)",
              borderWidth: 1,
            },
          ],
        },
        options: {
          plugins: {
            legend: { display: false },
            title: { display: true, text: "Top 10 สินค้าขายดีประจำวัน" },
          },
        },
      };
      chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(
        JSON.stringify(chartConfig)
      )}`;
    }

    await sendSummaryToDiscord(
      title,
      0x9b59b6,
      descriptionPrefix,
      formattedLines,
      fields,
      chartUrl
    );
    console.log("Daily summary sent successfully.");

    // Append to Google Sheets
    await appendDailySummaryToGoogleSheet({
      dateStr: targetDate.toFormat("yyyy-MM-dd"),
      totalRevenue,
      totalReceipts,
      totalItemsSold,
      totalOpeningCash,
      totalPayIns,
      totalPayOuts,
      totalExpectedCash,
      totalActualCash,
      difference: totalActualCash - totalExpectedCash,
      groupedItems,
      allItemsArray,
    });
  } catch (error) {
    console.error("Error fetching daily summary:", error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
    }
  }
}

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
