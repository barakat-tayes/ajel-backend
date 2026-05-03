ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS owner_name VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS city VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS province VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS status ENUM('pending','active','suspended') NOT NULL DEFAULT 'pending';

CREATE TABLE IF NOT EXISTS drivers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(40) NOT NULL,
  province VARCHAR(100) NULL,
  vehicle_type VARCHAR(80) NULL,
  vehicle_plate VARCHAR(80) NULL,
  status ENUM('available','busy','offline') NOT NULL DEFAULT 'offline',
  account_status ENUM('pending','active','suspended') NOT NULL DEFAULT 'pending',
  current_order_id INT NULL,
  current_lat DECIMAL(10,7) NULL,
  current_lng DECIMAL(10,7) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_number VARCHAR(80) NOT NULL UNIQUE,
  restaurant_id INT NOT NULL,
  driver_id INT NULL,
  customer_name VARCHAR(120) NOT NULL,
  customer_phone VARCHAR(40) NOT NULL,
  customer_address TEXT NOT NULL,
  order_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  delivery_fee DECIMAL(12,2) NOT NULL DEFAULT 0,
  notes TEXT NULL,
  status ENUM('pending','accepted','picked_up','delivered','returned','cancelled') NOT NULL DEFAULT 'pending',
  payment_status VARCHAR(80) NULL,
  admin_commission DECIMAL(12,2) NOT NULL DEFAULT 0,
  restaurant_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  accepted_at DATETIME NULL,
  picked_up_at DATETIME NULL,
  delivered_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_restaurant FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  CONSTRAINT fk_orders_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS settlements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  settlement_month DATE NOT NULL,
  total_orders INT NOT NULL DEFAULT 0,
  total_order_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_delivery_fee DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_commission DECIMAL(12,2) NOT NULL DEFAULT 0,
  net_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  status ENUM('pending','paid') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_settlements_restaurant FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS order_rejected_drivers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  driver_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_order_driver (order_id, driver_id),
  INDEX idx_order_rejected_driver (driver_id),
  CONSTRAINT fk_rejected_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_rejected_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE
);

CREATE INDEX idx_restaurants_province ON restaurants(province);
CREATE INDEX idx_drivers_province_status ON drivers(province, status);
CREATE INDEX idx_orders_restaurant_created ON orders(restaurant_id, created_at);
CREATE INDEX idx_orders_driver_created ON orders(driver_id, created_at);
