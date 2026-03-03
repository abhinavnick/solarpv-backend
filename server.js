require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
--------------------------------
POSTGRES CONNECTION
--------------------------------
*/

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/*
--------------------------------
ANTI SCRAPING PROTECTION
--------------------------------
Prevents automated price scraping
*/

const apiKeyMiddleware = (req, res, next) => {

  const apiKey = req.headers["x-api-key"];

  if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
    return res.status(403).json({
      error: "Unauthorized API access"
    });
  }

  next();
};

/*
--------------------------------
ROOT ENDPOINT
--------------------------------
*/

app.get("/", (req, res) => {
  res.json({
    message: "SolarPV.store backend is running.",
    status: "OK"
  });
});

/*
--------------------------------
DATABASE TEST
--------------------------------
*/

app.get("/db-test", async (req, res) => {

  try {

    const result = await pool.query("SELECT NOW()");

    res.json({
      message: "Database connected",
      time: result.rows[0]
    });

  } catch (err) {

    res.status(500).json({
      error: "Database connection failed"
    });

  }

});

/*
--------------------------------
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
      systemSize
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

    const result = await pool.query(query, [
      category,
      subCategory,
      brand
    ]);

    const listings = result.rows;

    if (!listings.length) {
      return res.json({
        message: "No suppliers available"
      });
    }

    /*
    --------------------------------
    TRUST SCORE CALCULATION
    --------------------------------
    */

    const tierWeight = {
      Elite: 4,
      Gold: 3,
      Silver: 2,
      Bronze: 1
    };

    const scoredListings = listings.map(item => {

      const trustScore =
        (item.deliveryreliability * 0.4) +
        ((tierWeight[item.sellertier] || 1) * 20 * 0.3) +
        (item.transactionvolume * 0.2) +
        ((item.escrowenabled ? 10 : 0) * 0.1);

      const locationScore =
        item.country === buyerCountry ? 40 : 10;

      const deliveryScore =
        item.delivery_days <= 3 ? 20 :
        item.delivery_days <= 7 ? 15 :
        5;

      const priceScore =
        100 / item.price;

      const totalScore =
        locationScore +
        deliveryScore +
        trustScore +
        priceScore;

      return {
        ...item,
        totalScore
      };

    });

    scoredListings.sort((a, b) => b.totalScore - a.totalScore);

    const aiRecommended = scoredListings[0];

    const bestPrice = [...listings].sort((a, b) => a.price - b.price)[0];

    const trustedSupplier =
      [...listings].sort((a, b) =>
        b.deliveryreliability - a.deliveryreliability
      )[0];

    res.json({

      aiRecommendedSupplier: aiRecommended,

      bestPriceOption: bestPrice,

      trustedSupplier: trustedSupplier

    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "AI recommendation failed"
    });

  }

});

/*
--------------------------------
ADD TO CART
--------------------------------
*/

app.post("/api/cart/add", apiKeyMiddleware, async (req, res) => {

  try {

    const {
      userId,
      productId,
      sellerId,
      price
    } = req.body;

    await pool.query(
      `INSERT INTO cart_items
      (user_id, product_id, seller_id, price)
      VALUES ($1,$2,$3,$4)`,
      [userId, productId, sellerId, price]
    );

    res.json({
      success: true,
      message: "Item added to cart"
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "Cart insert failed"
    });

  }

});

/*
--------------------------------
GET CART
--------------------------------
*/

app.get("/api/cart", apiKeyMiddleware, async (req, res) => {

  try {

    const { userId } = req.query;

    const result = await pool.query(
      `SELECT * FROM cart_items WHERE user_id = $1`,
      [userId]
    );

    res.json({
      cart: result.rows
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "Cart retrieval failed"
    });

  }

});

/*
--------------------------------
START SERVER
--------------------------------
*/

app.listen(PORT, () => {

  console.log(`SolarPV Backend running on port ${PORT}`);

});
