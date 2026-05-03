ALTER TABLE restaurants
  ADD COLUMN province VARCHAR(100) NULL AFTER address;

ALTER TABLE drivers
  ADD COLUMN province VARCHAR(100) NULL AFTER phone,
  ADD COLUMN current_lat DECIMAL(10,7) NULL AFTER current_order_id,
  ADD COLUMN current_lng DECIMAL(10,7) NULL AFTER current_lat;

ALTER TABLE orders
  ADD COLUMN picked_up_at DATETIME NULL AFTER accepted_at,
  ADD COLUMN delivered_at DATETIME NULL AFTER picked_up_at;

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
