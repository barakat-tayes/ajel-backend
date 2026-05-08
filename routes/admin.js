const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const { pool } = require("../config/database");
const { verifyAdmin } = require("../middleware/auth");
const { notifyUser } = require("../config/socket");
const normalizeDigits = (value = "") => String(value).replace(/[^\d]/g, "");

let driverModerationColumnsEnsured = false;
const ensureDriverModerationColumns = async () => {
  if (driverModerationColumnsEnsured) return;
  const dbName = process.env.DB_NAME;
  if (!dbName) return;

  const [rows] = await pool.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'drivers'
        AND COLUMN_NAME IN ('suspended_until', 'suspension_reason')
    `,
    [dbName],
  );
  const existing = new Set((rows || []).map((r) => r.COLUMN_NAME));

  if (!existing.has("suspended_until")) {
    await pool.query(
      "ALTER TABLE drivers ADD COLUMN suspended_until DATETIME NULL",
    );
  }
  if (!existing.has("suspension_reason")) {
    await pool.query(
      "ALTER TABLE drivers ADD COLUMN suspension_reason VARCHAR(20) NULL",
    );
  }

  driverModerationColumnsEnsured = true;
};

const DEFAULTS = {
  contact_phone: "",
  contact_whatsapp: "",
  payment_master_card: "",
  payment_zain_cash: "",
  payment_asia_pay: "",
  policy_text:
    "باستخدامك للتطبيق، أنت توافق على الالتزام بقواعد الاستخدام ودقة بيانات الطلبات. يحق للإدارة تعليق أو إيقاف الحساب عند وجود إساءة استخدام أو مستحقات غير مسددة.",
};

const ensureSettingsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(100) PRIMARY KEY,
      setting_value TEXT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
};

const getAppSettings = async () => {
  await ensureSettingsTable();
  const [rows] = await pool.query(
    "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?,?,?,?,?,?)",
    [
      "contact_phone",
      "contact_whatsapp",
      "payment_master_card",
      "payment_zain_cash",
      "payment_asia_pay",
      "policy_text",
    ],
  );
  const map = {};
  rows.forEach((r) => {
    map[r.setting_key] = r.setting_value;
  });
  return {
    contact_phone: map.contact_phone || DEFAULTS.contact_phone,
    contact_whatsapp: map.contact_whatsapp || DEFAULTS.contact_whatsapp,
    payment_master_card:
      map.payment_master_card || DEFAULTS.payment_master_card,
    payment_zain_cash: map.payment_zain_cash || DEFAULTS.payment_zain_cash,
    payment_asia_pay: map.payment_asia_pay || DEFAULTS.payment_asia_pay,
    policy_text: map.policy_text || DEFAULTS.policy_text,
  };
};

const setAppSetting = async (key, value) => {
  await ensureSettingsTable();
  await pool.query(
    "INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
    [key, String(value ?? "")],
  );
};

router.get("/settings", verifyAdmin, async (req, res) => {
  try {
    const [[row]] = await pool.query(
      "SELECT username, commission_rate, per_order_fee FROM admins WHERE id=? LIMIT 1",
      [req.user.id],
    );
    const appSettings = await getAppSettings();
    res.json({
      username: row?.username || "",
      commission_rate: Number(row?.commission_rate || 0),
      per_order_fee: Number(row?.per_order_fee || 0),
      ...appSettings,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/settings", verifyAdmin, async (req, res) => {
  try {
    const hasPerOrderFee = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "per_order_fee",
    );
    const perOrderFee = Number(req.body?.per_order_fee || 0);
    if (hasPerOrderFee) {
      await pool.query("UPDATE admins SET per_order_fee=? WHERE id=?", [
        perOrderFee,
        req.user.id,
      ]);
    }
    const keys = [
      "contact_phone",
      "contact_whatsapp",
      "payment_master_card",
      "payment_zain_cash",
      "payment_asia_pay",
      "policy_text",
    ];
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        await setAppSetting(key, req.body[key]);
      }
    }
    const appSettings = await getAppSettings();
    res.json({
      message: "updated",
      per_order_fee: perOrderFee,
      ...appSettings,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/account", verifyAdmin, async (req, res) => {
  try {
    const username = String(req.body?.username || "")
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || "").trim();
    if (!username)
      return res.status(400).json({ error: "اسم مستخدم الأدمن مطلوب" });
    if (password && password.length < 3) {
      return res
        .status(400)
        .json({ error: "كلمة المرور يجب أن تكون 3 أحرف على الأقل" });
    }
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query("UPDATE admins SET username=?, password=? WHERE id=?", [
        username,
        hash,
        req.user.id,
      ]);
    } else {
      await pool.query("UPDATE admins SET username=? WHERE id=?", [
        username,
        req.user.id,
      ]);
    }
    res.json({ message: "updated" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/overview", verifyAdmin, async (req, res) => {
  try {
    const [[feeRow]] = await pool.query(
      "SELECT per_order_fee FROM admins WHERE id=? LIMIT 1",
      [req.user.id],
    );
    const perOrderFee = Number(feeRow?.per_order_fee || 0);
    const [[restaurants]] = await pool.query(
      "SELECT COUNT(*) count FROM restaurants WHERE status <> 'suspended'",
    );
    const [[drivers]] = await pool.query(
      "SELECT COUNT(*) count FROM drivers WHERE account_status = 'active'",
    );
    const [provinceRows] = await pool.query(
      `SELECT p.province,
              COALESCE(r.restaurants_count,0) restaurants_count,
              COALESCE(d.drivers_count,0) drivers_count,
              COALESCE(fin.completed_count,0) completed_count,
              COALESCE(fin.completed_count,0) * ? AS province_revenue
       FROM (
          SELECT province FROM restaurants WHERE province IS NOT NULL
          UNION
          SELECT province FROM drivers WHERE province IS NOT NULL
       ) p
       LEFT JOIN (
          SELECT province, COUNT(*) restaurants_count
          FROM restaurants
          WHERE province IS NOT NULL AND status <> 'suspended'
          GROUP BY province
       ) r ON r.province = p.province
       LEFT JOIN (
          SELECT province, COUNT(*) drivers_count
          FROM drivers
          WHERE province IS NOT NULL AND account_status='active'
          GROUP BY province
       ) d ON d.province = p.province
       LEFT JOIN (
          SELECT r.province, COUNT(*) completed_count
          FROM orders o
          JOIN restaurants r ON r.id = o.restaurant_id
          WHERE o.status='delivered' AND r.province IS NOT NULL
          GROUP BY r.province
       ) fin ON fin.province = p.province
       ORDER BY p.province ASC`,
      [perOrderFee],
    );
    const topProvince =
      [...provinceRows].sort(
        (a, b) =>
          b.restaurants_count +
          b.drivers_count -
          (a.restaurants_count + a.drivers_count),
      )[0] || null;
    res.json({
      totalRestaurants: restaurants.count,
      totalDrivers: drivers.count,
      topProvince,
      perOrderFee,
      provinces: provinceRows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/province/:name", verifyAdmin, async (req, res) => {
  try {
    const province = req.params.name;
    const [[restaurants]] = await pool.query(
      "SELECT COUNT(*) count FROM restaurants WHERE province=? AND status <> 'suspended'",
      [province],
    );
    const [[drivers]] = await pool.query(
      "SELECT COUNT(*) count FROM drivers WHERE province=? AND account_status='active'",
      [province],
    );
    res.json({
      province,
      restaurants: restaurants.count,
      drivers: drivers.count,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/restaurants-ledger", verifyAdmin, async (req, res) => {
  try {
    const [[feeRow]] = await pool.query(
      "SELECT per_order_fee FROM admins WHERE id=? LIMIT 1",
      [req.user.id],
    );
    const perOrderFee = Number(feeRow?.per_order_fee || 0);

    const [rows] = await pool.query(
      `SELECT r.id, r.name, r.owner_name, r.phone, r.address, r.province, r.location_lat, r.location_lng, r.location_link,
              r.last_settlement_at, r.status, r.suspension_warning_at, r.last_payment_reminder_at,
              COALESCE(stats.completed_count,0) completed_count,
              GREATEST((COALESCE(stats.completed_count,0) * ?) - COALESCE(paid_since_settlement.paid_amount,0), 0) AS current_due,
              COALESCE(paid_since_settlement.paid_amount,0) AS paid_since_settlement,
              COALESCE(hist.total_settled,0) AS total_settled,
              COALESCE(alltime.all_completed_count,0) AS all_completed_count,
              COALESCE(alltime.all_completed_count,0) * ? AS all_time_due
       FROM restaurants r
       LEFT JOIN (
          SELECT o.restaurant_id, COUNT(*) AS completed_count
          FROM orders o
          JOIN restaurants rr ON rr.id = o.restaurant_id
          WHERE o.status='delivered'
            AND (rr.last_settlement_at IS NULL OR o.delivered_at > rr.last_settlement_at)
          GROUP BY o.restaurant_id
       ) stats ON stats.restaurant_id = r.id
       LEFT JOIN (
          SELECT rs.restaurant_id, SUM(rs.settled_amount) AS paid_amount
          FROM restaurant_settlements rs
          JOIN restaurants rr ON rr.id = rs.restaurant_id
          WHERE rr.last_settlement_at IS NULL OR rs.settled_at > rr.last_settlement_at
          GROUP BY rs.restaurant_id
       ) paid_since_settlement ON paid_since_settlement.restaurant_id = r.id
       LEFT JOIN (
          SELECT restaurant_id, SUM(settled_amount) AS total_settled
          FROM restaurant_settlements
          GROUP BY restaurant_id
       ) hist ON hist.restaurant_id = r.id
       LEFT JOIN (
          SELECT restaurant_id, COUNT(*) AS all_completed_count
          FROM orders
          WHERE status='delivered'
          GROUP BY restaurant_id
       ) alltime ON alltime.restaurant_id = r.id
      ORDER BY (r.last_settlement_at IS NULL) DESC, r.last_settlement_at ASC, r.name ASC`,
      [perOrderFee, perOrderFee],
    );
    res.json({ perOrderFee, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/restaurants-ledger/:id/pay", verifyAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const paidAmount = Number(req.body?.paid_amount || 0);
    if (!id || paidAmount <= 0) {
      return res.status(400).json({ error: "قيمة التسديد غير صالحة" });
    }
    const [[feeRow]] = await pool.query(
      "SELECT per_order_fee FROM admins WHERE id=? LIMIT 1",
      [req.user.id],
    );
    const fee = Number(feeRow?.per_order_fee || 0);
    const [[grossRow]] = await pool.query(
      `SELECT COUNT(*) AS completed_count
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.restaurant_id=? AND o.status='delivered'
         AND (r.last_settlement_at IS NULL OR o.delivered_at > r.last_settlement_at)`,
      [id],
    );
    const grossDue = Number(grossRow?.completed_count || 0) * fee;
    const [[paidRow]] = await pool.query(
      `SELECT COALESCE(SUM(rs.settled_amount),0) AS paid_amount
       FROM restaurant_settlements rs
       JOIN restaurants r ON r.id = rs.restaurant_id
       WHERE rs.restaurant_id=?
         AND (r.last_settlement_at IS NULL OR rs.settled_at > r.last_settlement_at)`,
      [id],
    );
    const alreadyPaid = Number(paidRow?.paid_amount || 0);
    const remaining = Math.max(grossDue - alreadyPaid, 0);
    if (remaining <= 0) {
      return res
        .status(400)
        .json({ error: "لا يوجد مستحقات حالية على هذا التاجر" });
    }
    const appliedAmount = Math.min(paidAmount, remaining);
    await pool.query(
      "INSERT INTO restaurant_settlements (restaurant_id, settled_amount, settled_by_admin_id, note) VALUES (?, ?, ?, ?)",
      [id, appliedAmount, req.user.id || null, "partial_payment"],
    );

    const newRemaining = Math.max(remaining - appliedAmount, 0);
    if (newRemaining <= 0) {
      await pool.query(
        "UPDATE restaurants SET last_settlement_at=NOW(), suspension_warning_at=NULL, last_payment_reminder_at=NULL, status='active' WHERE id=?",
        [id],
      );
      notifyUser("restaurant", id, "admin_clear_warnings", {
        message: "تمت تسوية كامل المستحقات وإزالة التنبيهات",
      });
    }
    res.json({
      message: "paid",
      paid_amount: appliedAmount,
      remaining_after_payment: newRemaining,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put(
  "/restaurants-ledger/:id/reset-due",
  verifyAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const range = String(req.body?.range || "month");
      let dateCond = "";
      if (range === "today") dateCond = "AND DATE(o.delivered_at) = CURDATE()";
      else if (range === "week")
        dateCond = "AND YEARWEEK(o.delivered_at, 1) = YEARWEEK(CURDATE(), 1)";
      else if (range === "year")
        dateCond = "AND YEAR(o.delivered_at) = YEAR(CURDATE())";
      else
        dateCond =
          "AND MONTH(o.delivered_at) = MONTH(CURDATE()) AND YEAR(o.delivered_at) = YEAR(CURDATE())";

      const [[feeRow]] = await pool.query(
        "SELECT per_order_fee FROM admins WHERE id=? LIMIT 1",
        [req.user.id],
      );
      const fee = Number(feeRow?.per_order_fee || 0);
      const [[countRow]] = await pool.query(
        `SELECT COUNT(*) AS completed_count
       FROM orders o
       WHERE o.restaurant_id=? AND o.status='delivered' ${dateCond}`,
        [id],
      );
      const settledAmount = Number(countRow?.completed_count || 0) * fee;
      if (settledAmount > 0) {
        await pool.query(
          "INSERT INTO restaurant_settlements (restaurant_id, settled_amount, settled_by_admin_id, note) VALUES (?, ?, ?, ?)",
          [id, settledAmount, req.user.id || null, `range:${range}`],
        );
      }
      await pool.query(
        "UPDATE restaurants SET last_settlement_at=NOW(), suspension_warning_at=NULL, last_payment_reminder_at=NULL, status='active' WHERE id=?",
        [id],
      );
      notifyUser("restaurant", id, "admin_clear_warnings", {
        message: "تم تصفير الحساب وإزالة جميع التنبيهات",
      });
      res.json({ message: "settled", settledAmount });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.put("/restaurants-ledger/:id/remind", verifyAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[rest]] = await pool.query(
      "SELECT id, name FROM restaurants WHERE id=?",
      [id],
    );
    await pool.query(
      "UPDATE restaurants SET last_payment_reminder_at=NOW() WHERE id=?",
      [id],
    );
    if (rest?.id)
      notifyUser("restaurant", rest.id, "admin_payment_reminder", {
        message: "تنبيه: يرجى تسديد المستحقات",
        restaurantName: rest.name,
      });
    res.json({ message: "reminder_marked" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put(
  "/restaurants-ledger/:id/warn-suspension",
  verifyAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[rest]] = await pool.query(
        "SELECT id, name FROM restaurants WHERE id=?",
        [id],
      );
      await pool.query(
        "UPDATE restaurants SET suspension_warning_at=NOW() WHERE id=?",
        [id],
      );
      if (rest?.id)
        notifyUser("restaurant", rest.id, "admin_suspension_warning", {
          message: "تحذير: قد يتم غلق الحساب لعدم تسديد المستحقات",
          restaurantName: rest.name,
        });
      res.json({ message: "warning_marked" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.put(
  "/restaurants-ledger/:id/toggle-warning",
  verifyAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[rest]] = await pool.query(
        "SELECT id, name, suspension_warning_at FROM restaurants WHERE id=?",
        [id],
      );
      if (!rest?.id) return res.status(404).json({ error: "التاجر غير موجود" });
      const hasWarning = !!rest.suspension_warning_at;
      if (hasWarning) {
        await pool.query(
          "UPDATE restaurants SET suspension_warning_at=NULL WHERE id=?",
          [id],
        );
        notifyUser("restaurant", id, "admin_clear_warnings", {
          message: "تم إلغاء التحذير من قبل الإدارة",
        });
        return res.json({ message: "warning_removed" });
      }
      await pool.query(
        "UPDATE restaurants SET suspension_warning_at=NOW() WHERE id=?",
        [id],
      );
      notifyUser("restaurant", id, "admin_suspension_warning", {
        message: "تحذير: قد يتم غلق الحساب لعدم تسديد المستحقات",
        restaurantName: rest.name,
      });
      return res.json({ message: "warning_added" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.put("/restaurants-ledger/:id/suspend", verifyAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[rest]] = await pool.query(
      "SELECT id, name FROM restaurants WHERE id=?",
      [id],
    );
    await pool.query("UPDATE restaurants SET status='suspended' WHERE id=?", [
      id,
    ]);
    if (rest?.id)
      notifyUser("restaurant", rest.id, "admin_account_suspended", {
        message: "تم غلق حسابك من قبل الإدارة",
        restaurantName: rest.name,
      });
    res.json({ message: "suspended" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put(
  "/restaurants-ledger/:id/toggle-suspend",
  verifyAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[rest]] = await pool.query(
        "SELECT id, name, status FROM restaurants WHERE id=?",
        [id],
      );
      if (!rest?.id) return res.status(404).json({ error: "التاجر غير موجود" });
      if (rest.status === "suspended") {
        await pool.query("UPDATE restaurants SET status='active' WHERE id=?", [
          id,
        ]);
        notifyUser("restaurant", id, "admin_clear_warnings", {
          message: "تم فتح الحساب من قبل الإدارة",
        });
        return res.json({ message: "unsuspended" });
      }
      await pool.query("UPDATE restaurants SET status='suspended' WHERE id=?", [
        id,
      ]);
      notifyUser("restaurant", id, "admin_account_suspended", {
        message: "تم غلق حسابك من قبل الإدارة",
        restaurantName: rest.name,
      });
      return res.json({ message: "suspended" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.put(
  "/restaurants-ledger/:id/clear-flags",
  verifyAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      await pool.query(
        "UPDATE restaurants SET suspension_warning_at=NULL, last_payment_reminder_at=NULL, status='active' WHERE id=?",
        [id],
      );
      notifyUser("restaurant", id, "admin_clear_warnings", {
        message: "تم إلغاء التنبيهات/الحظر من قبل الإدارة",
      });
      res.json({ message: "flags_cleared" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.get("/suspended-restaurants", verifyAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, owner_name, phone, address, province, due_amount, suspension_warning_at FROM restaurants WHERE status='suspended' ORDER BY id DESC",
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/pending-approvals", verifyAdmin, async (req, res) => {
  try {
    const [restaurants] = await pool.query(
      "SELECT id, username, name, owner_name, phone, province, address, location_lat, location_lng, location_link, created_at FROM restaurants WHERE status='pending' ORDER BY created_at DESC",
    );
    const [drivers] = await pool.query(
      "SELECT id, username, name, phone, province, vehicle_type, vehicle_plate, created_at FROM drivers WHERE account_status='pending' ORDER BY created_at DESC",
    );
    res.json({ restaurants, drivers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/lookup-by-phone", verifyAdmin, async (req, res) => {
  try {
    const userType = String(req.query?.userType || "restaurant").trim();
    const phone = String(req.query?.phone || "").replace(/[^\d]/g, "");
    if (phone.length !== 11) return res.json({ found: false });
    if (!["restaurant", "driver"].includes(userType))
      return res.status(400).json({ error: "نوع غير صالح" });

    if (userType === "restaurant") {
      const [rows] = await pool.query(
        "SELECT id, name, owner_name, phone, province, address, status FROM restaurants WHERE username=? LIMIT 1",
        [phone],
      );
      if (!rows.length) return res.json({ found: false });
      return res.json({ found: true, userType, user: rows[0] });
    }

    const [rows] = await pool.query(
      "SELECT id, name, phone, province, vehicle_type, vehicle_plate, account_status FROM drivers WHERE username=? LIMIT 1",
      [phone],
    );
    if (!rows.length) return res.json({ found: false });
    return res.json({ found: true, userType, user: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/drivers", verifyAdmin, async (req, res) => {
  try {
    await ensureDriverModerationColumns();
    const province = String(req.query?.province || "").trim();
    const params = [];
    let where = "WHERE d.account_status <> 'pending'";
    if (province && province !== "__all__") {
      where += " AND d.province = ?";
      params.push(province);
    }
    const [rows] = await pool.query(
      `SELECT d.id, d.name, d.phone, d.province, d.vehicle_type, d.vehicle_plate, d.account_status, d.status,
              d.suspended_until, d.suspension_reason,
              COALESCE(ds.delivered_count,0) delivered_count,
              COALESCE(ds.delivered_amount,0) delivered_amount,
              COALESCE(rs.returned_count,0) returned_count,
              COALESCE(rs.returned_amount,0) returned_amount
       FROM drivers d
       LEFT JOIN (
          SELECT driver_id, COUNT(*) delivered_count, COALESCE(SUM(delivery_fee),0) delivered_amount
          FROM orders
          WHERE status='delivered'
          GROUP BY driver_id
       ) ds ON ds.driver_id = d.id
       LEFT JOIN (
          SELECT driver_id, COUNT(*) returned_count, COALESCE(SUM(collected_delivery_fee),0) returned_amount
          FROM orders
          WHERE status='returned'
          GROUP BY driver_id
       ) rs ON rs.driver_id = d.id
       ${where}
       ORDER BY d.id DESC`,
      params,
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/drivers/:id/suspend-24h", verifyAdmin, async (req, res) => {
  try {
    await ensureDriverModerationColumns();
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرف السائق غير صالح" });
    const [[driver]] = await pool.query(
      "SELECT id, name FROM drivers WHERE id=? LIMIT 1",
      [id],
    );
    if (!driver?.id) return res.status(404).json({ error: "السائق غير موجود" });

    await pool.query(
      "UPDATE drivers SET account_status='suspended', suspended_until=DATE_ADD(NOW(), INTERVAL 24 HOUR), suspension_reason='24h', status='available', current_order_id=NULL WHERE id=?",
      [id],
    );
    notifyUser("driver", id, "admin_driver_suspended", {
      kind: "24h",
      message:
        "تم إيقاف حسابك لمدة 24 ساعة بسبب شكوى أو سوء استعمال. راجين منكم استخدام التطبيق بأفضل صورة من أجل استمرارية العمل للجميع.",
    });
    res.json({ message: "driver_suspended_24h" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/drivers/:id/suspend-72h", verifyAdmin, async (req, res) => {
  try {
    await ensureDriverModerationColumns();
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرف السائق غير صالح" });
    const [[driver]] = await pool.query(
      "SELECT id, name FROM drivers WHERE id=? LIMIT 1",
      [id],
    );
    if (!driver?.id) return res.status(404).json({ error: "السائق غير موجود" });

    await pool.query(
      "UPDATE drivers SET account_status='suspended', suspended_until=DATE_ADD(NOW(), INTERVAL 72 HOUR), suspension_reason='72h', status='available', current_order_id=NULL WHERE id=?",
      [id],
    );
    notifyUser("driver", id, "admin_driver_suspended", {
      kind: "72h",
      message:
        "تم إيقاف حسابك لمدة 72 ساعة بسبب شكوى أو سوء استعمال. راجين منكم استخدام التطبيق بأفضل صورة من أجل استمرارية العمل للجميع.",
    });
    res.json({ message: "driver_suspended_72h" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/drivers/:id/toggle-suspend", verifyAdmin, async (req, res) => {
  try {
    await ensureDriverModerationColumns();
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرف السائق غير صالح" });
    const [[driver]] = await pool.query(
      "SELECT id, account_status, suspended_until, suspension_reason FROM drivers WHERE id=? LIMIT 1",
      [id],
    );
    if (!driver?.id) return res.status(404).json({ error: "السائق غير موجود" });

    const isManualSuspended =
      driver.account_status === "suspended" &&
      (!driver.suspended_until || driver.suspension_reason === "manual");

    if (isManualSuspended) {
      await pool.query(
        "UPDATE drivers SET account_status='active', suspended_until=NULL, suspension_reason=NULL, status='available', current_order_id=NULL WHERE id=?",
        [id],
      );
      notifyUser("driver", id, "admin_driver_unsuspended", {
        message: "تم إعادة تفعيل حسابك من قبل الإدارة.",
      });
      return res.json({ message: "driver_unsuspended" });
    }

    // Last action wins: convert any previous suspension state (timed or active) to manual suspend.
    await pool.query(
      "UPDATE drivers SET account_status='suspended', suspended_until=NULL, suspension_reason='manual', status='available', current_order_id=NULL WHERE id=?",
      [id],
    );
    notifyUser("driver", id, "admin_driver_suspended", {
      kind: "manual",
      message: "تم إيقاف حسابك من قبل إدارة التطبيق.",
    });
    return res.json({ message: "driver_suspended_manual" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/drivers/:id/clear-suspend", verifyAdmin, async (req, res) => {
  try {
    await ensureDriverModerationColumns();
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرف السائق غير صالح" });
    const [[driver]] = await pool.query(
      "SELECT id FROM drivers WHERE id=? LIMIT 1",
      [id],
    );
    if (!driver?.id) return res.status(404).json({ error: "السائق غير موجود" });

    await pool.query(
      "UPDATE drivers SET account_status='active', suspended_until=NULL, suspension_reason=NULL, status='available', current_order_id=NULL WHERE id=?",
      [id],
    );
    notifyUser("driver", id, "admin_driver_unsuspended", {
      message: "تم إعادة تفعيل حسابك من قبل الإدارة.",
    });
    res.json({ message: "driver_unsuspended" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/drivers/:id", verifyAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرف السائق غير صالح" });
    notifyUser("driver", id, "account_deleted", {
      message: "تم حذف حسابك من قبل الإدارة",
    });
    await pool.query(
      "UPDATE orders SET driver_id=NULL, status='pending', accepted_at=NULL, picked_up_at=NULL, delivered_at=NULL WHERE driver_id=? AND status IN ('accepted','picked_up')",
      [id],
    );
    await pool.query("DELETE FROM order_rejected_drivers WHERE driver_id=?", [
      id,
    ]);
    await pool.query("DELETE FROM drivers WHERE id=?", [id]);
    res.json({ message: "driver_deleted" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/restaurants/:id", verifyAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرف التاجر غير صالح" });

    const [activeOrders] = await pool.query(
      "SELECT id FROM orders WHERE restaurant_id=? AND status IN ('pending','accepted','picked_up') LIMIT 1",
      [id],
    );
    if (activeOrders.length) {
      return res
        .status(400)
        .json({ error: "لا يمكن حذف حساب التاجر لوجود طلبات نشطة أو معلقة" });
    }

    notifyUser("restaurant", id, "account_deleted", {
      message: "تم حذف حسابك من قبل الإدارة",
    });
    await pool.query(
      "DELETE FROM restaurant_settlements WHERE restaurant_id=?",
      [id],
    );
    await pool.query("DELETE FROM orders WHERE restaurant_id=?", [id]);
    await pool.query("DELETE FROM restaurants WHERE id=?", [id]);
    res.json({ message: "restaurant_deleted" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/approve/:type/:id", verifyAdmin, async (req, res) => {
  try {
    const { type, id } = req.params;
    if (type === "restaurant") {
      await pool.query("UPDATE restaurants SET status='active' WHERE id=?", [
        id,
      ]);
    } else if (type === "driver") {
      await pool.query(
        "UPDATE drivers SET account_status='active', status='available', current_order_id=NULL, suspended_until=NULL, suspension_reason=NULL WHERE id=?",
        [id],
      );
    } else {
      return res.status(400).json({ error: "نوع غير صالح" });
    }
    res.json({ message: "approved" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/reject/:type/:id", verifyAdmin, async (req, res) => {
  try {
    const { type, id } = req.params;
    if (type === "restaurant") {
      await pool.query("UPDATE restaurants SET status='suspended' WHERE id=?", [
        id,
      ]);
    } else if (type === "driver") {
      await pool.query(
        "UPDATE drivers SET account_status='suspended' WHERE id=?",
        [id],
      );
    } else {
      return res.status(400).json({ error: "نوع غير صالح" });
    }
    res.json({ message: "rejected" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/temporary-password", verifyAdmin, async (req, res) => {
  try {
    const { userType, phone, tempPassword } = req.body || {};
    const username = normalizeDigits(phone);
    const newPass = String(tempPassword || "").trim();
    if (!["restaurant", "driver"].includes(userType)) {
      return res.status(400).json({ error: "نوع المستخدم غير صالح" });
    }
    if (username.length !== 11) {
      return res.status(400).json({ error: "رقم الهاتف يجب أن يكون 11 خانة" });
    }
    if (!newPass) {
      return res.status(400).json({ error: "كلمة المرور المؤقتة مطلوبة" });
    }
    const table = userType === "restaurant" ? "restaurants" : "drivers";
    const [rows] = await pool.query(
      `SELECT id, name FROM ${table} WHERE username=? LIMIT 1`,
      [username],
    );
    if (!rows.length) {
      return res
        .status(404)
        .json({ error: "لم يتم العثور على مستخدم بهذا الرقم" });
    }
    const hash = await bcrypt.hash(newPass, 10);
    await pool.query(`UPDATE ${table} SET password=? WHERE id=?`, [
      hash,
      rows[0].id,
    ]);
    res.json({
      message: "تم تعيين كلمة مرور مؤقتة بنجاح",
      user: { id: rows[0].id, name: rows[0].name },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
