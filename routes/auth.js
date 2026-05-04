const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { pool } = require("../config/database");
const { notifyAdmins } = require("../config/socket");

const getTableByType = (userType) => {
    if (userType === "admin") return "admins";
    if (userType === "restaurant") return "restaurants";
    if (userType === "driver") return "drivers";
    return "";
};

const normalizeDigits = (value = "") => String(value).replace(/[^\d]/g, "");
const normalizePassword = (value = "") => String(value).trim();
const normalizeIp = (req) => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
const DISABLE_LOGIN_THROTTLE = String(process.env.DISABLE_LOGIN_THROTTLE || "true").toLowerCase() === "true";

const authRateState = new Map();
const accountLockState = new Map();
const isRateLimited = (key, { limit, windowMs }) => {
    const now = Date.now();
    const current = authRateState.get(key) || { count: 0, resetAt: now + windowMs };
    if (current.resetAt < now) {
        current.count = 0;
        current.resetAt = now + windowMs;
    }
    current.count += 1;
    authRateState.set(key, current);
    return current.count > limit;
};

const loginGuard = (req, res, next) => {
    if (DISABLE_LOGIN_THROTTLE) return next();
    const ip = normalizeIp(req);
    const key = `login:${ip}`;
    if (isRateLimited(key, { limit: 15, windowMs: 10 * 60 * 1000 })) {
        return res.status(429).json({ error: "محاولات كثيرة، حاول بعد قليل" });
    }
    next();
};

const accountLockGuard = (usernameKey) => {
    const now = Date.now();
    const row = accountLockState.get(usernameKey);
    if (!row) return { locked: false };
    if (row.lockUntil && row.lockUntil > now) {
        return { locked: true, waitMs: row.lockUntil - now };
    }
    return { locked: false };
};

const registerLoginFailure = (usernameKey) => {
    const now = Date.now();
    const row = accountLockState.get(usernameKey) || { fails: 0, firstAt: now, lockUntil: 0 };
    if (now - row.firstAt > 15 * 60 * 1000) {
        row.fails = 0;
        row.firstAt = now;
    }
    row.fails += 1;
    if (row.fails >= 8) {
        row.lockUntil = now + 15 * 60 * 1000;
        row.fails = 0;
        row.firstAt = now;
    }
    accountLockState.set(usernameKey, row);
};

const clearLoginFailures = (usernameKey) => {
    accountLockState.delete(usernameKey);
};

const phoneTakenAnywhere = async(usernameDigits) => {
    const [r] = await pool.query("SELECT id FROM restaurants WHERE username = ? LIMIT 1", [usernameDigits]);
    if (r.length) return true;
    const [d] = await pool.query("SELECT id FROM drivers WHERE username = ? LIMIT 1", [usernameDigits]);
    if (d.length) return true;
    return false;
};

const tryAdminLogin = async(username, cleanPassword) => {
    const adminUsername = String(username || "").trim().toLowerCase();
    if (!adminUsername) return null;
    const [admins] = await pool.query("SELECT * FROM admins WHERE username = ? LIMIT 1", [adminUsername]);
    if (!admins.length) return null;
    const admin = admins[0];
    let validPassword = false;
    try {
        validPassword = await bcrypt.compare(cleanPassword, admin.password);
    } catch {
        validPassword = false;
    }
    if (!validPassword && admin.password === cleanPassword) {
        validPassword = true;
    }
    if (!validPassword) return null;
    return admin;
};

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

const resolveDriverStatusForLogin = async (driver) => {
    if (!driver || driver.account_status !== "suspended") return driver;
    if (!driver.suspended_until) return driver;
    const now = new Date();
    const until = new Date(driver.suspended_until);
    if (Number.isNaN(until.getTime()) || now < until) return driver;

    await pool.query(
        "UPDATE drivers SET account_status='active', suspended_until=NULL, suspension_reason=NULL, status='available', current_order_id=NULL WHERE id=?",
        [driver.id]
    );
    const [rows] = await pool.query("SELECT * FROM drivers WHERE id=? LIMIT 1", [driver.id]);
    return rows[0] || driver;
};

router.post("/register/restaurant", async(req, res) => {
    try {
        const { phone, password, name, owner_name, province, address, location_lat, location_lng, location_link } = req.body;
        const username = normalizeDigits(phone);
        const cleanPassword = normalizePassword(password);

        if (!phone || !cleanPassword || !name || !owner_name || !province || !address) {
            return res.status(400).json({ error: "بيانات التسجيل ناقصة" });
        }
        if (username.length !== 11) return res.status(400).json({ error: "رقم المستخدم يجب أن يكون 11 خانة" });
        if (await phoneTakenAnywhere(username)) {
            return res.status(409).json({ error: "رقم الهاتف مستخدم مسبقًا بحساب آخر" });
        }

        const hashedPassword = await bcrypt.hash(cleanPassword, 10);
        await pool.query(
            "INSERT INTO restaurants (username, password, name, owner_name, phone, address, province, location_lat, location_lng, location_link, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')", [username, hashedPassword, name, owner_name, phone.trim(), address, province, location_lat || null, location_lng || null, location_link || null]
        );
        notifyAdmins("new_join_request", {
            userType: "restaurant",
            phone: phone.trim(),
            name,
            owner_name,
            province,
        });
        res.status(201).json({ message: "تم إرسال طلب التسجيل بنجاح" });
    } catch {
        res.status(500).json({ error: "تعذر التسجيل، تحقق من رقم الهاتف" });
    }
});

router.post("/register/driver", async(req, res) => {
    try {
        const { phone, password, name, province, vehicle_type, vehicle_plate } = req.body;
        const username = normalizeDigits(phone);
        const cleanPassword = normalizePassword(password);

        if (!phone || !cleanPassword || !name || !province || !vehicle_type || !vehicle_plate) {
            return res.status(400).json({ error: "بيانات التسجيل ناقصة" });
        }
        if (username.length !== 11) return res.status(400).json({ error: "رقم المستخدم يجب أن يكون 11 خانة" });
        if (await phoneTakenAnywhere(username)) {
            return res.status(409).json({ error: "رقم الهاتف مستخدم مسبقًا بحساب آخر" });
        }

        const hashedPassword = await bcrypt.hash(cleanPassword, 10);
        await pool.query(
            "INSERT INTO drivers (username, password, name, phone, vehicle_type, vehicle_plate, province, account_status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')", [username, hashedPassword, name, phone.trim(), vehicle_type, vehicle_plate, province]
        );
        notifyAdmins("new_join_request", {
            userType: "driver",
            phone: phone.trim(),
            name,
            province,
            vehicle_type,
        });
        res.status(201).json({ message: "تم إرسال طلب التسجيل بنجاح" });
    } catch {
        res.status(500).json({ error: "تعذر التسجيل، تحقق من رقم الهاتف" });
    }
});

router.post("/login", loginGuard, async(req, res) => {
    const { username, password, userType } = req.body;
    const cleanPassword = normalizePassword(password);
    try {
        const table = getTableByType(userType);
        if (!table) return res.status(400).json({ error: "نوع مستخدم غير صالح" });
        const attemptedUsername = String(username || "").trim().toLowerCase();
        const lockKey = `${userType}:${attemptedUsername}`;
        const lock = DISABLE_LOGIN_THROTTLE ? { locked: false } : accountLockGuard(lockKey);
        if (lock.locked) {
            return res.status(429).json({ error: "تم قفل الحساب مؤقتًا بسبب محاولات كثيرة، حاول لاحقًا" });
        }

        let users;
        if (userType === "admin") {
            [users] = await pool.query(`SELECT * FROM ${table} WHERE username = ? LIMIT 1`, [String(username || "").trim().toLowerCase()]);
            if (!users.length) {
                if (!DISABLE_LOGIN_THROTTLE) registerLoginFailure(lockKey);
                return res.status(401).json({ error: "البريد أو كلمة المرور خاطئة" });
            }
        } else {
            const rawUsername = String(username || "").trim();
            const normalizedUsername = normalizeDigits(rawUsername);
            if (normalizedUsername.length !== 11 || rawUsername !== normalizedUsername) {
                const admin = await tryAdminLogin(rawUsername, cleanPassword);
                if (admin) {
                    if (!DISABLE_LOGIN_THROTTLE) clearLoginFailures(lockKey);
                    const token = jwt.sign({ id: admin.id, userType: "admin", name: admin.name }, process.env.JWT_SECRET, { expiresIn: "24h" });
                    return res.json({ token, user: { id: admin.id, name: admin.name, userType: "admin", province: null, phone: null } });
                }
                if (!DISABLE_LOGIN_THROTTLE) registerLoginFailure(lockKey);
                return res.status(401).json({ error: "رقم المستخدم أو كلمة المرور خاطئة" });
            }
            [users] = await pool.query(`SELECT * FROM ${table} WHERE username = ? LIMIT 1`, [rawUsername]);
            if (!users.length) {
                const admin = await tryAdminLogin(rawUsername, cleanPassword);
                if (admin) {
                    if (!DISABLE_LOGIN_THROTTLE) clearLoginFailures(lockKey);
                    const token = jwt.sign({ id: admin.id, userType: "admin", name: admin.name }, process.env.JWT_SECRET, { expiresIn: "24h" });
                    return res.json({ token, user: { id: admin.id, name: admin.name, userType: "admin", province: null, phone: null } });
                }
                if (!DISABLE_LOGIN_THROTTLE) registerLoginFailure(lockKey);
                return res.status(401).json({ error: "رقم المستخدم أو كلمة المرور خاطئة" });
            }
        }

        let user = users[0];

        if (userType === "driver") {
            user = await resolveDriverStatusForLogin(user);
        }

        if (userType !== "admin") {
            const accountStatus = userType === "restaurant" ? user.status : user.account_status;
            if (accountStatus === "pending") return res.status(403).json({ error: "حسابك قيد المراجعة" });
            if (accountStatus === "suspended") {
                if (userType === "driver") {
                    if (user.suspension_reason === "24h") {
                        const until = user.suspended_until ? new Date(user.suspended_until) : null;
                        const remaining = until && !Number.isNaN(until.getTime()) ? formatRemaining(until) : "غير محددة";
                        return res.status(403).json({
                            error: `تم إيقاف حسابك لمدة 24 ساعة بسبب شكوى أو سوء استعمال. المدة المتبقية: ${remaining}. راجين منكم استخدام التطبيق بأحسن صورة من أجل استمرارية العمل للجميع.`,
                        });
                    }
                    if (user.suspension_reason === "72h") {
                        const until = user.suspended_until ? new Date(user.suspended_until) : null;
                        const remaining = until && !Number.isNaN(until.getTime()) ? formatRemaining(until) : "غير محددة";
                        return res.status(403).json({
                            error: `تم إيقاف حسابك لمدة 72 ساعة بسبب شكوى أو سوء استعمال. المدة المتبقية: ${remaining}. راجين منكم استخدام التطبيق بأحسن صورة من أجل استمرارية العمل للجميع.`,
                        });
                    }
                    return res.status(403).json({ error: "تم إيقاف حسابك من قبل إدارة التطبيق. يرجى التواصل مع الإدارة." });
                }
                return res.status(403).json({ error: "حسابك موقوف" });
            }
        }

        let validPassword = false;
        try {
            validPassword = await bcrypt.compare(cleanPassword, user.password);
        } catch {
            validPassword = false;
        }
        if (!validPassword && user.password === cleanPassword) {
            validPassword = true;
        }

        if (!validPassword) {
            if (!DISABLE_LOGIN_THROTTLE) registerLoginFailure(lockKey);
            return res.status(401).json({ error: userType === "admin" ? "البريد أو كلمة المرور خاطئة" : "رقم المستخدم أو كلمة المرور خاطئة" });
        }
        if (!DISABLE_LOGIN_THROTTLE) clearLoginFailures(lockKey);

        const token = jwt.sign({ id: user.id, userType, name: user.name }, process.env.JWT_SECRET, { expiresIn: "24h" });
        res.json({ token, user: { id: user.id, name: user.name, userType, province: user.province || null, phone: user.phone } });
    } catch {
        res.status(500).json({ error: "حدث خطأ في الخادم" });
    }
});

module.exports = router;
