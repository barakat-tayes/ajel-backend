const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../config/database");
const { verifyRestaurant, verifyAdmin, verifyDriver } = require("../middleware/auth");
const { notifyDrivers, notifyDriversByProvince, notifyUser, notifyAdmins } = require("../config/socket");

const router = express.Router();

router.post("/", verifyRestaurant, async (req, res) => {
  try {
    const { customer_name, customer_phone, customer_address, order_type, order_amount, delivery_fee, notes } = req.body;
    if (!customer_name || !customer_phone || !customer_address || !order_type || !order_amount || !delivery_fee) {
      return res.status(400).json({ error: "All required fields are missing" });
    }

    const orderNumber = `ORD-${Date.now()}-${uuidv4().slice(0, 4).toUpperCase()}`;
    const [[restaurant]] = await pool.query("SELECT province FROM restaurants WHERE id = ?", [req.user.id]);
    const province = restaurant?.province || null;

    const [insert] = await pool.query(
      `INSERT INTO orders
      (order_number, restaurant_id, customer_name, customer_phone, customer_address, order_type, order_amount, delivery_fee, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderNumber, req.user.id, customer_name, customer_phone, customer_address, order_type, order_amount, delivery_fee, notes || ""]
    );

    const payload = {
      orderId: insert.insertId,
      orderNumber,
      orderAmount: order_amount,
      deliveryFee: delivery_fee,
      restaurantName: req.user.name,
      from: req.user.name,
      to: customer_address,
      province,
    };
    if (province) notifyDriversByProvince(province, "new_order", payload);
    else notifyDrivers("new_order", payload);
    notifyAdmins("new_order_created", { orderId: insert.insertId, orderNumber });

    res.status(201).json({ message: "Order created", orderId: insert.insertId, orderNumber });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/", verifyAdmin, async (req, res) => {
  try {
    const { status, date, restaurant_id } = req.query;
    let q = `SELECT o.*, r.name restaurant_name, d.name driver_name
             FROM orders o
             JOIN restaurants r ON r.id = o.restaurant_id
             LEFT JOIN drivers d ON d.id = o.driver_id`;
    const where = [];
    const params = [];
    if (status) { where.push("o.status = ?"); params.push(status); }
    if (date) { where.push("DATE(o.created_at) = ?"); params.push(date); }
    if (restaurant_id) { where.push("o.restaurant_id = ?"); params.push(restaurant_id); }
    if (where.length) q += ` WHERE ${where.join(" AND ")}`;
    q += " ORDER BY o.created_at DESC";
    const [rows] = await pool.query(q, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/report/daily", verifyAdmin, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const [rows] = await pool.query(
      `SELECT DATE(created_at) date, COUNT(*) total_orders, SUM(order_amount) total_amount,
              SUM(delivery_fee) total_delivery, SUM(admin_commission) total_commission
       FROM orders
       WHERE DATE(created_at) BETWEEN ? AND ?
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
      [start_date, end_date]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/available", verifyDriver, async (req, res) => {
  try {
    const [[driver]] = await pool.query("SELECT province FROM drivers WHERE id = ?", [req.user.id]);
    const province = driver?.province || null;
    const [rows] = await pool.query(
      `SELECT o.*, r.name restaurant_name, r.address restaurant_address, r.phone restaurant_phone, r.province restaurant_province
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.status = 'pending'
         AND r.status = 'active'
         AND (? IS NULL OR r.province = ?)
         AND o.id NOT IN (SELECT order_id FROM order_rejected_drivers WHERE driver_id = ?)
       ORDER BY o.id DESC`,
      [province, province, req.user.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/:id/cancel", verifyRestaurant, async (req, res) => {
  try {
    const [orders] = await pool.query("SELECT * FROM orders WHERE id = ? AND restaurant_id = ?", [req.params.id, req.user.id]);
    if (!orders.length) return res.status(404).json({ error: "Order not found" });
    if (orders[0].status !== "pending") return res.status(400).json({ error: "Cannot cancel after acceptance" });
    await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = ?", [req.params.id]);
    notifyAdmins("order_cancelled", { orderId: req.params.id });
    res.json({ message: "Cancelled" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/reject-driver/:driverId", verifyRestaurant, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const driverId = Number(req.params.driverId);
    const [orders] = await pool.query("SELECT * FROM orders WHERE id = ? AND restaurant_id = ?", [orderId, req.user.id]);
    if (!orders.length) return res.status(404).json({ error: "Order not found" });
    const order = orders[0];
    if (order.status !== "accepted") return res.status(400).json({ error: "لا يمكن رفض السائق بعد استلامه الطلب" });
    if (order.driver_id !== driverId) return res.status(400).json({ error: "Driver has not accepted this order" });

    await pool.query("DELETE FROM order_rejected_drivers WHERE order_id = ? AND driver_id = ?", [orderId, driverId]);
    await pool.query("INSERT INTO order_rejected_drivers (order_id, driver_id) VALUES (?, ?)", [orderId, driverId]);
    await pool.query("UPDATE orders SET status = 'pending', driver_id = NULL WHERE id = ?", [orderId]);
    await pool.query("UPDATE drivers SET status = 'available', current_order_id = NULL WHERE id = ?", [driverId]);

    const [[restaurant]] = await pool.query("SELECT province FROM restaurants WHERE id = ?", [req.user.id]);
    const province = restaurant?.province || null;
    const payload = { orderId, orderNumber: order.order_number, excludedDriverId: driverId };
    if (province) notifyDriversByProvince(province, "order_returned", payload);
    else notifyDrivers("order_returned", payload);

    notifyAdmins("driver_rejected", { orderId, driverId, restaurantId: req.user.id });
    res.json({ message: "Driver rejected" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.*, r.name restaurant_name, r.address restaurant_address, d.name driver_name, d.phone driver_phone
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN drivers d ON d.id = o.driver_id
       WHERE o.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Order not found" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
