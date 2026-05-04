const express = require("express");
const router = express.Router();
const { pool } = require("../config/database");
const { verifyDriver } = require("../middleware/auth");
const { notifyUser, notifyAdmins } = require("../config/socket");
const bcrypt = require("bcryptjs");

// Get driver profile
router.get("/profile", verifyDriver, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, username, name, phone, province, vehicle_type, vehicle_plate, status, account_status, created_at FROM drivers WHERE id = ?",
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "السائق غير موجود" });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update driver profile
router.put("/profile", verifyDriver, async (req, res) => {
  try {
    const { name, phone, province, vehicle_type, vehicle_plate } = req.body;
    await pool.query(
      "UPDATE drivers SET name=?, phone=?, province=?, vehicle_type=?, vehicle_plate=? WHERE id=?",
      [name, phone, province, vehicle_type, vehicle_plate, req.user.id]
    );
    res.json({ message: "تم تحديث الملف الشخصي" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/current-order", verifyDriver, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.*, r.name as restaurant_name, r.address as restaurant_address, r.phone as restaurant_phone
       FROM orders o
       JOIN restaurants r ON o.restaurant_id = r.id
       WHERE o.driver_id = ? AND o.status IN ('accepted', 'picked_up')`,
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/accept-order/:orderId", verifyDriver, async (req, res) => {
  let conn;
  try {
    const { orderId } = req.params;
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [driverRows] = await conn.query("SELECT * FROM drivers WHERE id = ? FOR UPDATE", [req.user.id]);
    if (!driverRows.length) {
      await conn.rollback();
      return res.status(404).json({ error: "السائق غير موجود" });
    }
    const driver = driverRows[0];
    if (driver.status === "busy") {
      // Idempotent success: already busy on this same order
      if (Number(driver.current_order_id) === Number(orderId)) {
        const [sameOrderRows] = await conn.query("SELECT status, driver_id FROM orders WHERE id = ? FOR UPDATE", [orderId]);
        const sameOrder = sameOrderRows[0];
        if (sameOrder && sameOrder.status === "accepted" && Number(sameOrder.driver_id) === Number(req.user.id)) {
          await conn.commit();
          return res.json({ message: "تم قبول الطلبية مسبقًا", orderId: Number(orderId), status: "accepted" });
        }
      }
      await conn.rollback();
      return res.status(400).json({ error: "لا يمكنك قبول طلبية جديدة لأنك مشغول حاليًا" });
    }
    if (driver.account_status !== "active") {
      await conn.rollback();
      return res.status(403).json({ error: "حساب السائق غير مفعل" });
    }

    const [orderRows] = await conn.query(
      `SELECT o.*, r.province as restaurant_province
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.id = ? FOR UPDATE`,
      [orderId]
    );
    if (!orderRows.length) {
      await conn.rollback();
      return res.status(404).json({ error: "الطلبية غير موجودة أو تم حذفها" });
    }
    const order = orderRows[0];
    if (order.status !== "pending") {
      if (order.status === "accepted" && Number(order.driver_id) === Number(req.user.id)) {
        await conn.commit();
        return res.json({ message: "تم قبول الطلبية مسبقًا", orderId: Number(orderId), status: "accepted" });
      }
      await conn.rollback();
      return res.status(400).json({ error: `الطلبية في حالة غير صالحة للقبول (${order.status})` });
    }
    if (driver.province && order.restaurant_province && driver.province !== order.restaurant_province) {
      await conn.rollback();
      return res.status(403).json({ error: "لا يمكن قبول طلبية من محافظة مختلفة" });
    }

    const [rejected] = await conn.query(
      "SELECT * FROM order_rejected_drivers WHERE order_id = ? AND driver_id = ?",
      [orderId, req.user.id]
    );
    if (rejected.length) {
      await conn.rollback();
      return res.status(403).json({ error: "لقد رفضت هذه الطلبية مسبقًا" });
    }

    const [claimOrder] = await conn.query(
      "UPDATE orders SET status='accepted', driver_id=?, accepted_at=NOW() WHERE id=? AND status='pending'",
      [req.user.id, orderId]
    );
    if (!claimOrder?.affectedRows) {
      await conn.rollback();
      return res.status(409).json({ error: "الطلبية لم تعد متاحة" });
    }

    const [setBusy] = await conn.query(
      "UPDATE drivers SET status='busy', current_order_id=? WHERE id=? AND status='available'",
      [orderId, req.user.id]
    );
    if (!setBusy?.affectedRows) {
      await conn.rollback();
      return res.status(409).json({ error: "تعذر تحديث حالة السائق، حاول مرة أخرى" });
    }

    await conn.commit();
    notifyUser("restaurant", order.restaurant_id, "order_accepted", {
      orderId,
      driverId: req.user.id,
      driverName: driver.name,
      driverPhone: driver.phone,
    });
    notifyAdmins("order_accepted", { orderId, driverId: req.user.id, driverName: driver.name });
    res.json({ message: "تم قبول الطلبية بنجاح", orderId: Number(orderId), status: "accepted" });
  } catch (error) {
    if (conn) {
      try { await conn.rollback(); } catch {}
    }
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

router.post("/reject-order/:orderId", verifyDriver, async (req, res) => {
  try {
    const { orderId } = req.params;
    const [order] = await pool.query("SELECT id, status FROM orders WHERE id=?", [orderId]);
    if (!order.length) return res.status(404).json({ error: "الطلبية غير موجودة" });
    if (order[0].status !== "pending") {
      return res.json({ message: `تم تحديث الحالة (${order[0].status})`, orderId, status: order[0].status });
    }
    await pool.query("INSERT IGNORE INTO order_rejected_drivers (order_id, driver_id) VALUES (?, ?)", [orderId, req.user.id]);
    res.json({ message: "تم رفض الطلبية لك فقط", orderId, status: "rejected_for_driver" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/order/:orderId/cancel-reservation", verifyDriver, async (req, res) => {
  try {
    const { orderId } = req.params;
    const [order] = await pool.query("SELECT * FROM orders WHERE id = ? AND driver_id = ?", [orderId, req.user.id]);
    if (!order.length) return res.status(404).json({ error: "الطلبية غير موجودة" });
    if (order[0].status !== "accepted") {
      return res.json({ message: `لا يمكن إلغاء الحجز الآن (${order[0].status})`, orderId, status: order[0].status });
    }
    await pool.query("UPDATE orders SET status='pending', driver_id=NULL, accepted_at=NULL WHERE id=?", [orderId]);
    await pool.query("UPDATE drivers SET status='available', current_order_id=NULL WHERE id=?", [req.user.id]);
    notifyUser("restaurant", order[0].restaurant_id, "order_returned", { orderId, status: "pending" });
    res.json({ message: "تم إلغاء الحجز", orderId, status: "pending" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/order/:orderId/picked-up", verifyDriver, async (req, res) => {
  try {
    const { orderId } = req.params;
    const [order] = await pool.query("SELECT * FROM orders WHERE id = ? AND driver_id = ?", [orderId, req.user.id]);
    if (!order.length) return res.status(404).json({ error: "الطلبية غير موجودة" });
    if (["picked_up", "delivered", "returned", "cancelled"].includes(order[0].status)) {
      return res.json({ message: `تم تحديث الحالة (${order[0].status})`, orderId, status: order[0].status });
    }
    if (order[0].status !== "accepted") return res.status(400).json({ error: `الطلبية في حالة غير صالحة (${order[0].status})` });
    await pool.query("UPDATE orders SET status='picked_up', picked_up_at=NOW() WHERE id=?", [orderId]);
    notifyUser("restaurant", order[0].restaurant_id, "order_picked_up", { orderId });
    notifyAdmins("order_picked_up", { orderId });
    res.json({ message: "تم استلام الطلبية", orderId, status: "picked_up" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/order/:orderId/delivered", verifyDriver, async (req, res) => {
  try {
    const { orderId } = req.params;
    const [order] = await pool.query("SELECT * FROM orders WHERE id = ? AND driver_id = ?", [orderId, req.user.id]);
    if (!order.length) return res.status(404).json({ error: "الطلبية غير موجودة" });
    if (order[0].status !== "picked_up") return res.status(400).json({ error: "الطلبية في حالة غير صالحة للتسليم" });
    const totalAmount = Number(order[0].order_amount) + Number(order[0].delivery_fee);
    await pool.query("UPDATE orders SET status='delivered', delivered_at=NOW(), payment_status='paid_to_driver' WHERE id=?", [orderId]);
    await pool.query("UPDATE drivers SET status='available', current_order_id=NULL WHERE id=?", [req.user.id]);
    notifyUser("restaurant", order[0].restaurant_id, "order_delivered", { orderId, totalAmount });
    notifyAdmins("order_delivered", { orderId, totalAmount });
    res.json({ message: "تم تسليم الطلبية", orderId, amount: totalAmount, status: "delivered" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/order/:orderId/returned", verifyDriver, async (req, res) => {
  try {
    const { orderId } = req.params;
    const collected = Number(req.body?.collected_delivery_fee || 0);
    const [order] = await pool.query("SELECT * FROM orders WHERE id = ? AND driver_id = ?", [orderId, req.user.id]);
    if (!order.length) return res.status(404).json({ error: "الطلبية غير موجودة" });
    if (order[0].status !== "picked_up") return res.status(400).json({ error: "الطلبية ليست في حالة صالحة للإرجاع" });
    await pool.query(
      "UPDATE orders SET status='returned', delivered_at=NOW(), payment_status='returned_to_restaurant', collected_delivery_fee=? WHERE id=?",
      [collected, orderId]
    );
    await pool.query("UPDATE drivers SET status='available', current_order_id=NULL WHERE id=?", [req.user.id]);
    notifyUser("restaurant", order[0].restaurant_id, "order_returned", { orderId });
    notifyAdmins("order_returned", { orderId, driverId: req.user.id });
    res.json({ message: "تم إرجاع الطلبية", orderId, status: "returned" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/stats", verifyDriver, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let dateCond = "";
    const paramsCompleted = [req.user.id];
    const paramsReturned = [req.user.id];
    if (start_date) {
      dateCond += " AND DATE(delivered_at) >= ?";
      paramsCompleted.push(start_date);
      paramsReturned.push(start_date);
    }
    if (end_date) {
      dateCond += " AND DATE(delivered_at) <= ?";
      paramsCompleted.push(end_date);
      paramsReturned.push(end_date);
    }
    const [completedOrders] = await pool.query(
      `SELECT COUNT(*) as count, COALESCE(SUM(delivery_fee),0) as total_amount
       FROM orders
       WHERE driver_id=? AND status='delivered' ${dateCond}`,
      paramsCompleted
    );
    const [returnedOrders] = await pool.query(
      `SELECT COUNT(*) as count, COALESCE(SUM(CASE WHEN collected_delivery_fee > 0 THEN collected_delivery_fee ELSE 0 END),0) as total_amount
       FROM orders
       WHERE driver_id=? AND status='returned' ${dateCond}`,
      paramsReturned
    );
    const [rejectedOrders] = await pool.query("SELECT COUNT(*) as count FROM order_rejected_drivers WHERE driver_id=?", [req.user.id]);
    res.json({
      completedOrders: completedOrders[0].count,
      completedAmount: completedOrders[0].total_amount || 0,
      returnedOrders: returnedOrders[0].count,
      returnedAmount: returnedOrders[0].total_amount || 0,
      rejectedOrders: rejectedOrders[0].count,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/change-password", verifyDriver, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const [rows] = await pool.query("SELECT password FROM drivers WHERE id = ?", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "السائق غير موجود" });
    const valid = await bcrypt.compare(String(currentPassword || ""), rows[0].password);
    if (!valid) return res.status(400).json({ error: "كلمة المرور الحالية غير صحيحة" });
    const hash = await bcrypt.hash(String(newPassword || ""), 10);
    await pool.query("UPDATE drivers SET password=? WHERE id=?", [hash, req.user.id]);
    res.json({ message: "تم تغيير كلمة المرور" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
