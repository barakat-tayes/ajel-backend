CREATE TABLE IF NOT EXISTS password_reset_otps (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_type ENUM('admin','restaurant','driver') NOT NULL,
  user_id INT NOT NULL,
  username VARCHAR(120) NOT NULL,
  otp_code VARCHAR(10) NOT NULL,
  expires_at DATETIME NOT NULL,
  used TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_password_reset_lookup (username, user_type, used, expires_at)
);
