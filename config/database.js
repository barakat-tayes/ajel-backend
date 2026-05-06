const mysql = require("mysql2/promise");
require("dotenv").config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "ajel_db",
  timezone: process.env.DB_TIMEZONE || "+03:00",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

const dbSessionTimezone = process.env.DB_TIMEZONE || "+03:00";
pool.on("connection", (conn) => {
  conn.query("SET time_zone = ?", [dbSessionTimezone], () => {});
});

// Test connection
const testConnection = async () => {
  try {
    const connection = await pool.getConnection();
    console.log("✅ MySQL Database connected successfully");
    connection.release();
    return true;
  } catch (error) {
    console.error("❌ MySQL Connection Error:", error.message);
    return false;
  }
};

module.exports = {
  pool,
  testConnection,
};
