const express = require("express");
const router = express.Router();
const { pool } = require("../config/database");
const { verifyAdmin } = require("../middleware/auth");

// جلب تسوية تاجر لشهر معين
router.get("/restaurant/:id", verifyAdmin, async(req, res) => {
    const { id } = req.params;
    const { month } = req.query; // YYYY-MM
    try {
        const [rows] = await pool.query(
            `SELECT COUNT(*) as orders_count, SUM(order_amount) as total_sales, 
             SUM(admin_commission) as total_commission, SUM(restaurant_amount) as net_for_restaurant 
             FROM orders 
             WHERE restaurant_id = ? AND status = 'delivered' AND DATE_FORMAT(delivered_at, '%Y-%m') = ?`, [id, month],
        );
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;