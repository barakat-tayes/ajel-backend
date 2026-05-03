const express = require("express");
const { pool } = require("../config/database");

const router = express.Router();

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

const readSettings = async () => {
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
    ]
  );
  const map = {};
  rows.forEach((r) => {
    map[r.setting_key] = r.setting_value;
  });
  return {
    contact_phone: map.contact_phone || DEFAULTS.contact_phone,
    contact_whatsapp: map.contact_whatsapp || DEFAULTS.contact_whatsapp,
    payment_master_card: map.payment_master_card || DEFAULTS.payment_master_card,
    payment_zain_cash: map.payment_zain_cash || DEFAULTS.payment_zain_cash,
    payment_asia_pay: map.payment_asia_pay || DEFAULTS.payment_asia_pay,
    policy_text: map.policy_text || DEFAULTS.policy_text,
  };
};

router.get("/contact-payment", async (req, res) => {
  try {
    const settings = await readSettings();
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
