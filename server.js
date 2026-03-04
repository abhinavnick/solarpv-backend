require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const slowDown = require("express-slow-down");
const { Pool } = require("pg");

const app = express();

/* --------------------------------
SECURITY MIDDLEWARE
--------------------------------
*/
app.use(helmet());
app.use(compression());
app.use(cors({ origin: "*" }));
app.use(express.json());

// Railway environment uses process.env.PORT
const PORT = process.env.PORT || 3000;

/* --------------------------------
RATE LIMIT (ANTI SCRAPING)
--------------------------------
*/
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests. Please try again later."
});
app.use("/api/", apiLimiter);

/* --------------------------------
BOT SLOWDOWN PROTECTION
--------------------------------
*/
const speedLimiter = slowDown({
  windowMs: 60 * 1000,
  delayAfter: 20,
  delayMs: (hits) => 500 // Updated for compatibility with latest express-slow-down
});
app.use("/api/", speedLimiter);

/* --------------------------------
POSTGRES CONNECTION
--------------------------------
*/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* --------------------------------
API KEY SECURITY
--------------------------------
*/
const apiKeyMiddleware = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
    return res.status(403).json({
      success: false,
      error: "Unauthorized API access"
    });
  }
  next();
};

/* --------------------------------
ROOT ENDPOINT
--------------------------------
*/
app.get("/", (req, res) => {
  res.json({
    message: "SolarPV.store backend running",
    status: "OK"
  });
});

/* --------------------------------
DATABASE TEST
--------------------------------
*/
app.get("/db-test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      success: true,
      message: "Database connected",
      time: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: "Database connection failed"
    });
  }
});

/* --------------------------------
AI RECOMMENDATION ENGINE
--------------------------------
*/
app.post("/api/ai-recommendations", apiKeyMiddleware, async (req, res) => {
  try {
    const {
      category,
      subCategory,
      brand,
      buyerCountry,
      systemSizeKW
    } = req.body;

    const query = `
      SELECT
        p.id as product_id,
        p.name,
        p.brand,
        p.category,
        p.sub_category,
        l.price,
        l.stock,
        l.delivery_days,
        s.id as seller_id,
        s.company_name,
        s.country,
        s.sellertier,
        s.deliveryreliability,
        s.transactionvolume,
        s.escrowenabled
      FROM product_listings l
      JOIN products p ON l.productid = p.id
      JOIN sellers s ON l.sellerid = s.id
      WHERE p.category = $1
      AND p.sub_category = $2
      AND p.brand = $3
      AND l.stock > 0
    `;

    const result = await pool.query(query, [category, subCategory, brand]);
    const listings = result.rows;

    if (!listings.length) {
      return res.json({
        success: false,
        message: "No suppliers found"
      });
    }

    /* --------------------------------
    TRUST SCORE CALCULATION
    --------------------------------
    */
    const tierWeight = { Elite: 4, Gold: 3, Silver: 2, Bronze: 1 };

    const scoredListings = listings.map(item => {
      const trustScore =
        (item.deliveryreliability * 0.4) +
        ((tierWeight[item.sellertier] || 1) * 20 * 0.3) +
        (item.transactionvolume * 0.2) +
        ((item.escrowenabled ? 10 : 0) * 0.1);

      const locationScore = item.country === buyerCountry ? 40 : 10;
      const deliveryScore = item.delivery_days <= 3 ? 20 : item.delivery_days <= 7 ? 15 : 5;
      const priceScore = 100 / item.price;

      const totalScore = locationScore + deliveryScore + trustScore + priceScore;

      return { ...item, totalScore };
    });

    scoredListings.sort((a, b) => b.totalScore - a.totalScore);

    const aiRecommended = scoredListings[0];
    const bestPrice = [...listings].sort((a, b) => a.price - b.price)[0];
    const trustedSupplier = [...listings].sort((a, b) => b.deliveryreliability - a.deliveryreliability)[0];

    /* --------------------------------
    BOQ CALCULATION
    --------------------------------
    */
    let boq = null;
    if (systemSizeKW) {
      const avgPanelWatt = 550;
      const panels = Math.ceil((systemSizeKW * 1000) / avgPanelWatt);
      const inverterKW = (systemSizeKW * 1.2).toFixed(2);
      const batteryKWh = (systemSizeKW * 4).toFixed(2);
      const totalPrice = panels * aiRecommended.price;

      boq = { panels, inverterKW, batteryKWh, totalPrice };
    }

    res.json({
      success: true,
      data: {
        recommendations: [
          {
            type: "ai_recommended",
            productId: aiRecommended.product_id,
            productName: aiRecommended.name,
            price: aiRecommended.price,
            sellerName: aiRecommended.company_name,
            sellerTier: aiRecommended.sellertier,
            deliveryDays: aiRecommended.delivery_days,
            quantity: 1
          },
          {
            type: "best_price",
            productId: bestPrice.product_id,
            productName: bestPrice.name,
            price: bestPrice.price,
            sellerName: bestPrice.company_name,
            sellerTier: bestPrice.sellertier,
            deliveryDays: bestPrice.delivery_days,
            quantity: 1
          },
          {
            type: "trusted_supplier",
            productId: trustedSupplier.product_id,
            productName: trustedSupplier.name,
            price: trustedSupplier.price,
            sellerName: trustedSupplier.company_name,
            sellerTier: trustedSupplier.sellertier,
            deliveryDays: trustedSupplier.delivery_days,
            quantity: 1
          }
        ],
        boq
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "AI recommendation failed" });
  }
});

/* --------------------------------
ADD TO CART
--------------------------------
*/
app.post("/api/cart/add", apiKeyMiddleware, async (req, res) => {
  try {
    const { userId, productId, sellerId, price } = req.body;
    await pool.query(
      `INSERT INTO cart_items (user_id, product_id, seller_id, price) VALUES ($1,$2,$3,$4)`,
      [userId, productId, sellerId, price]
    );
    res.json({ success: true, message: "Item added to cart" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Cart insert failed" });
  }
});

/* --------------------------------
GET CART
--------------------------------
*/
app.get("/api/cart", apiKeyMiddleware, async (req, res) => {
  try {
    const { userId } = req.query;
    const result = await pool.query(`SELECT * FROM cart_items WHERE user_id = $1`, [userId]);
    res.json({ success: true, cart: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Cart retrieval failed" });
  }
});

app.listen(PORT, () => {
  console.log(`SolarPV Backend running on port ${PORT}`);
});
