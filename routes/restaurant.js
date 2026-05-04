const express = require("express");
const router = express.Router();
const { pool } = require("../config/database");
const { verifyRestaurant } = require("../middleware/auth");
const bcrypt = require("bcryptjs");
const { notifyDriversByProvince, notifyDrivers } = require("../config/socket");

// Get restaurant profile
router.get("/profile", verifyRestaurant, async(req, res) => {
    try {
        const [rows] = await pool.query(
            "SELECT id, username, name, owner_name, phone, address, city, province, location_lat, location_lng, location_link, status, suspension_warning_at, last_payment_reminder_at, created_at FROM restaurants WHERE id = ?", [req.user.id],
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: "التاجر غير موجود" });
        }
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update restaurant profile
router.put("/profile", verifyRestaurant, async(req, res) => {
    try {
        const { name, owner_name, phone, address, city, province, location_lat, location_lng, location_link } = req.body;
        await pool.query(
            "UPDATE restaurants SET name = ?, owner_name = ?, phone = ?, address = ?, city = ?, province = ?, location_lat = ?, location_lng = ?, location_link = ? WHERE id = ?", [name, owner_name, phone, address, city, province, location_lat || null, location_lng || null, location_link || null, req.user.id],
        );
        res.json({ message: "تم تحديث الملف الشخصي" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get restaurant orders
router.get("/orders", verifyRestaurant, async(req, res) => {
    try {
        const { status, start_date, end_date } = req.query;
        let query = `SELECT o.*, d.name as driver_name, d.phone as driver_phone, d.vehicle_type, d.current_lat, d.current_lng
                     FROM orders o
                     LEFT JOIN drivers d ON o.driver_id = d.id
                     WHERE o.restaurant_id = ?`;
        let params = [req.user.id];

        if (status) {
            query += " AND o.status = ?";
            params.push(status);
        }
        const dateExpr = "DATE(CASE WHEN o.status IN ('delivered','returned') AND o.delivered_at IS NOT NULL THEN o.delivered_at ELSE o.created_at END)";
        if (start_date) {
            query += ` AND ${dateExpr} >= ?`;
            params.push(start_date);
        }
        if (end_date) {
            query += ` AND ${dateExpr} <= ?`;
            params.push(end_date);
        }

        query += " ORDER BY o.created_at DESC";

        const [rows] = await pool.query(query, params);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get("/active-order-tracking", verifyRestaurant, async(req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT o.id, o.order_number, o.customer_name, o.order_type, o.order_amount, o.delivery_fee, o.customer_address, o.status, o.accepted_at, o.picked_up_at, o.delivered_at, d.id as driver_id, d.name as driver_name, d.phone as driver_phone, d.vehicle_type, d.current_lat, d.current_lng
             FROM orders o
             JOIN drivers d ON o.driver_id = d.id
             WHERE o.restaurant_id = ? AND o.status IN ('accepted','picked_up')
             ORDER BY o.created_at DESC
            `,
            [req.user.id]
        );
        res.json(rows || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get restaurant stats
router.get("/stats", verifyRestaurant, async(req, res) => {
    try {
        const [totalOrders] = await pool.query(
            "SELECT COUNT(*) as count FROM orders WHERE restaurant_id = ?", [req.user.id],
        );
        const [completedOrders] = await pool.query(
            "SELECT COUNT(*) as count, SUM(order_amount) as revenue FROM orders WHERE restaurant_id = ? AND status = 'delivered'", [req.user.id],
        );
        const [pendingOrders] = await pool.query(
            "SELECT COUNT(*) as count FROM orders WHERE restaurant_id = ? AND status = 'pending'", [req.user.id],
        );
        const [thisMonthOrders] = await pool.query(
            "SELECT COUNT(*) as count, SUM(order_amount) as revenue FROM orders WHERE restaurant_id = ? AND MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())", [req.user.id],
        );

        res.json({
            totalOrders: totalOrders[0].count,
            completedOrders: completedOrders[0].count,
            pendingOrders: pendingOrders[0].count,
            totalRevenue: completedOrders[0].revenue || 0,
            thisMonthOrders: thisMonthOrders[0].count,
            thisMonthRevenue: thisMonthOrders[0].revenue || 0,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Current due amount since last settlement (admin per-order fee * delivered orders since last settlement)
router.get("/due-summary", verifyRestaurant, async(req, res) => {
    try {
        const [[adminRow]] = await pool.query("SELECT per_order_fee FROM admins ORDER BY id ASC LIMIT 1");
        const perOrderFee = Number(adminRow?.per_order_fee || 0);
        const [[restRow]] = await pool.query("SELECT last_settlement_at FROM restaurants WHERE id = ?", [req.user.id]);
        const lastSettlementAt = restRow?.last_settlement_at || null;

        let countQuery = "SELECT COUNT(*) as completed_count FROM orders WHERE restaurant_id = ? AND status = 'delivered'";
        const params = [req.user.id];
        if (lastSettlementAt) {
            countQuery += " AND delivered_at > ?";
            params.push(lastSettlementAt);
        }
        const [[countRow]] = await pool.query(countQuery, params);
        const completedOrdersCount = Number(countRow?.completed_count || 0);
        const grossDueAmount = completedOrdersCount * perOrderFee;

        let paidAmount = 0;
        try {
            let paidQuery = "SELECT COALESCE(SUM(settled_amount),0) AS paid_amount FROM restaurant_settlements WHERE restaurant_id = ?";
            const paidParams = [req.user.id];
            if (lastSettlementAt) {
                paidQuery += " AND settled_at > ?";
                paidParams.push(lastSettlementAt);
            }
            const [[paidRow]] = await pool.query(paidQuery, paidParams);
            paidAmount = Number(paidRow?.paid_amount || 0);
        } catch (e) {
            // In case settlement history table is missing in some environments, keep app running.
            if (e?.code !== "ER_NO_SUCH_TABLE") throw e;
            paidAmount = 0;
        }

        const dueAmount = Math.max(grossDueAmount - paidAmount, 0);
        const dueUnitsRaw = perOrderFee > 0 ? dueAmount / perOrderFee : 0;
        const dueUnits = Math.round(dueUnitsRaw * 100) / 100;

        res.json({
            per_order_fee: perOrderFee,
            completed_count: dueUnits,
            completed_orders_count: completedOrdersCount,
            due_amount: dueAmount,
            paid_amount_since_settlement: paidAmount,
            last_settlement_at: lastSettlementAt,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get restaurant settlements
router.get("/settlements", verifyRestaurant, async(req, res) => {
    try {
        const [rows] = await pool.query(
            "SELECT * FROM settlements WHERE restaurant_id = ? ORDER BY settlement_month DESC", [req.user.id],
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Cancel pending order by restaurant (hard delete)
router.delete("/orders/:id", verifyRestaurant, async(req, res) => {
    try {
        const orderId = Number(req.params.id);
        if (!orderId) return res.status(400).json({ error: "رقم طلب غير صالح" });

        const [rows] = await pool.query(
            "SELECT id, status FROM orders WHERE id = ? AND restaurant_id = ? LIMIT 1", [orderId, req.user.id]
        );
        if (!rows.length) return res.status(404).json({ error: "الطلبية غير موجودة" });
        if (rows[0].status !== "pending") {
            return res.status(400).json({ error: "لا يمكن إلغاء الطلبية بعد قبولها" });
        }

        const [[restRow]] = await pool.query("SELECT province FROM restaurants WHERE id = ?", [req.user.id]);
        const province = restRow?.province || null;

        await pool.query("DELETE FROM orders WHERE id = ? AND restaurant_id = ? AND status = 'pending'", [orderId, req.user.id]);
        const payload = { orderId, cancelledBy: "restaurant" };
        if (province) notifyDriversByProvince(province, "order_cancelled_by_restaurant", payload);
        else notifyDrivers("order_cancelled_by_restaurant", payload);
        res.json({ message: "تم إلغاء الطلبية" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put("/change-password", verifyRestaurant, async(req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const [rows] = await pool.query("SELECT password FROM restaurants WHERE id = ?", [req.user.id]);
        if (!rows.length) return res.status(404).json({ error: "التاجر غير موجود" });
        const valid = await bcrypt.compare(currentPassword, rows[0].password);
        if (!valid) return res.status(400).json({ error: "كلمة المرور الحالية غير صحيحة" });
        const hash = await bcrypt.hash(newPassword, 10);
        await pool.query("UPDATE restaurants SET password = ? WHERE id = ?", [hash, req.user.id]);
        res.json({ message: "تم تغيير كلمة المرور" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
