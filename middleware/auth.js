const jwt = require("jsonwebtoken");
const { pool } = require("../config/database");

const formatRemaining = (untilDate) => {
  const diffMs = untilDate.getTime() - Date.now();
  if (diffMs <= 0) return "0 دقيقة";
  const totalMinutes = Math.ceil(diffMs / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes} دقيقة`;
  if (minutes === 0) return `${hours} ساعة`;
  return `${hours} ساعة و ${minutes} دقيقة`;
};

const resolveDriverStatus = async (driverId) => {
  let driver;
  try {
    [[driver]] = await pool.query(
      "SELECT account_status, suspended_until, suspension_reason FROM drivers WHERE id=? LIMIT 1",
      [driverId]
    );
  } catch (e) {
    if (e && e.code === "ER_BAD_FIELD_ERROR") {
      [[driver]] = await pool.query("SELECT account_status FROM drivers WHERE id=? LIMIT 1", [driverId]);
      if (driver) {
        driver.suspended_until = null;
        driver.suspension_reason = null;
      }
    } else {
      throw e;
    }
  }
  if (!driver) return { exists: false };

  if (driver.account_status === "suspended" && driver.suspended_until) {
    const now = new Date();
    const until = new Date(driver.suspended_until);
    if (!Number.isNaN(until.getTime()) && now >= until) {
      await pool.query(
        "UPDATE drivers SET account_status='active', suspended_until=NULL, suspension_reason=NULL, status='available', current_order_id=NULL WHERE id=?",
        [driverId]
      );
      return { exists: true, account_status: "active" };
    }
  }

  return { exists: true, ...driver };
};

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "الرجاء تسجيل الدخول أولًا" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "fawri_secret_key_change_me");
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجددًا" });
    }
    return res.status(403).json({ error: "توكن غير صالح" });
  }
};

const verifyAdmin = (req, res, next) => {
  verifyToken(req, res, () => {
    if (req.user.userType !== "admin") return res.status(403).json({ error: "صلاحية أدمن مطلوبة" });
    next();
  });
};

const verifyRestaurant = (req, res, next) => {
  verifyToken(req, res, () => {
    if (req.user.userType !== "restaurant") return res.status(403).json({ error: "صلاحية تاجر مطلوبة" });
    next();
  });
};

const verifyDriver = (req, res, next) => {
  verifyToken(req, res, async () => {
    if (req.user.userType !== "driver") return res.status(403).json({ error: "صلاحية سائق مطلوبة" });
    try {
      const driver = await resolveDriverStatus(req.user.id);
      if (!driver.exists) return res.status(403).json({ error: "حساب السائق غير موجود" });

      if (driver.account_status === "suspended") {
        if (driver.suspension_reason === "24h") {
          const until = driver.suspended_until ? new Date(driver.suspended_until) : null;
          const remaining = until && !Number.isNaN(until.getTime()) ? formatRemaining(until) : "غير محددة";
          return res.status(403).json({
            error: `تم إيقاف حسابك لمدة 24 ساعة بسبب شكوى أو سوء استعمال. المدة المتبقية: ${remaining}. راجين منكم استخدام التطبيق بأحسن صورة من أجل استمرارية العمل للجميع.`,
          });
        }
        if (driver.suspension_reason === "72h") {
          const until = driver.suspended_until ? new Date(driver.suspended_until) : null;
          const remaining = until && !Number.isNaN(until.getTime()) ? formatRemaining(until) : "غير محددة";
          return res.status(403).json({
            error: `تم إيقاف حسابك لمدة 72 ساعة بسبب شكوى أو سوء استعمال. المدة المتبقية: ${remaining}. راجين منكم استخدام التطبيق بأحسن صورة من أجل استمرارية العمل للجميع.`,
          });
        }
        return res.status(403).json({
          error: "تم إيقاف حسابك من قبل إدارة التطبيق. يرجى التواصل مع الإدارة.",
          blocked: true,
        });
      }

      next();
    } catch {
      return res.status(500).json({ error: "تعذر التحقق من حالة السائق" });
    }
  });
};

module.exports = { verifyToken, verifyAdmin, verifyRestaurant, verifyDriver };
