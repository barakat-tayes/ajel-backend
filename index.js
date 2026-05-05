const express = require("express");
const http = require("http");
const cors = require("cors");
const dotenv = require("dotenv");
const { testConnection } = require("./config/database");
const { initSocket } = require("./config/socket");

const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const restaurantRoutes = require("./routes/restaurant");
const driverRoutes = require("./routes/driver");
const orderRoutes = require("./routes/orders");
const settlementRoutes = require("./routes/settlements");
const publicRoutes = require("./routes/public");

dotenv.config();

const app = express();
const server = http.createServer(app);
initSocket(server);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
const allowAllCors = allowedOrigins.includes("*");

app.disable("x-powered-by");
app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "geolocation=(self), microphone=(), camera=()");
    next();
});

app.use(cors({
    origin(origin, cb) {
        if (allowAllCors) return cb(null, true);
        if (!origin) return cb(null, true);
        if (allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error("CORS blocked"));
    },
    credentials: true
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/restaurants", restaurantRoutes);
app.use("/api/drivers", driverRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/settlements", settlementRoutes);
app.use("/api/public", publicRoutes);

app.get("/api/health", (req, res) => {
    res.json({ status: "ok", message: "Ajel API is running" });
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: "Something went wrong!" });
});

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, async() => {
    console.log(`Server running on http://${HOST}:${PORT}`);
    await testConnection();
});
