require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const slowDown = require("express-slow-down");
const { Pool } = require("pg");

const app = express();
app.set('trust proxy', 1); // Crucial for Railway proxy networking

app.use(helmet());
app.use(compression());
app.use(cors({ origin: "*" }));
app.use(express.json());

// Protection Logic
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const speedLimiter = slowDown({ windowMs: 60 * 1000, delayAfter: 20, delayMs: (hits) => 500 });
app.use("/api/", apiLimiter, speedLimiter);

// DB Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const apiKeyMiddleware = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
    return res.status(403).json({ success: false, error: "Unauthorized" });
  }
  next();
};

// Endpoints
app.get("/", (req, res) => res.status(200).json({ message: "SolarPV Backend Online", status: "OK" }));

app.get("/db-test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ success: true, time: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* AI RECOMMENDATION ENGINE (Full Logic) */
app.post("/api/ai-recommendations", apiKeyMiddleware, async (req, res) => {
  try {
    const { category, subCategory, brand, buyerCountry, systemSizeKW } = req.body;
    const query = `
      SELECT p.id as product_id, p.name, p.brand, p.category, p.sub_category, 
             l.price, l.stock, l.delivery_days, s.id as seller_id, 
             s.company_name, s.country, s.sellertier, s.deliveryreliability, 
             s.transactionvolume, s.escrowenabled
      FROM product_listings l
      JOIN products p ON l.productid = p.id
      JOIN sellers s ON l.sellerid = s.id
      WHERE p.category = $1 AND p.sub_category = $2 AND p.brand = $3 AND l.stock > 0
    `;
    const result = await pool.query(query, [category, subCategory, brand]);
    const listings = result.rows;
    if (!listings.length) return res.json({ success: false, message: "No suppliers found" });

    const tierWeight = { Elite: 4, Gold: 3, Silver: 2, Bronze: 1 };
    const scoredListings = listings.map(item => {
      const trustScore = (item.deliveryreliability * 0.4) + ((tierWeight[item.sellertier] || 1) * 20 * 0.3) + (item.transactionvolume * 0.2) + ((item.escrowenabled ? 10 : 0) * 0.1);
      const totalScore = (item.country === buyerCountry ? 40 : 10) + (item.delivery_days <= 3 ? 20 : 5) + trustScore + (100 / item.price);
      return { ...item, totalScore };
    });
    scoredListings.sort((a, b) => b.totalScore - a.totalScore);
    const ai = scoredListings[0];
    const best = [...listings].sort((a, b) => a.price - b.price)[0];
    const trust = [...listings].sort((a, b) => b.deliveryreliability - a.deliveryreliability)[0];

    let boq = null;
    if (systemSizeKW) {
      const panels = Math.ceil((systemSizeKW * 1000) / 550);
      boq = { panels, inverterKW: (systemSizeKW * 1.2).toFixed(2), batteryKWh: (systemSizeKW * 4).toFixed(2), totalPrice: (panels * ai.price).toFixed(2) };
    }

    res.json({ success: true, data: { recommendations: [
      { type: "ai_recommended", productId: ai.product_id, productName: ai.name, price: ai.price, sellerName: ai.company_name, sellerTier: ai.sellertier, deliveryDays: ai.delivery_days, quantity: 1 },
      { type: "best_price", productId: best.product_id, productName: best.name, price: best.price, sellerName: best.company_name, sellerTier: best.sellertier, deliveryDays: best.delivery_days, quantity: 1 },
      { type: "trusted_supplier", productId: trust.product_id, productName: trust.name, price: trust.price, sellerName: trust.company_name, sellerTier: trust.sellertier, deliveryDays: trust.delivery_days, quantity: 1 }
    ], boq } });
  } catch (err) { res.status(500).json({ success: false, error: "AI error" }); }
});

// START SERVER (MANDATORY RAILWAY BINDING)
const PORT = process.env.PORT || 3000;
app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`SolarPV Backend is live on port ${PORT}`);
});
