CREATE TABLE IF NOT EXISTS restaurant_settlements (
  id INT PRIMARY KEY AUTO_INCREMENT,
  restaurant_id INT NOT NULL,
  settled_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  settled_by_admin_id INT NULL,
  settled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note VARCHAR(255) NULL,
  INDEX idx_restaurant_settlements_restaurant_id (restaurant_id),
  INDEX idx_restaurant_settlements_settled_at (settled_at),
  CONSTRAINT fk_restaurant_settlements_restaurant
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
    ON DELETE CASCADE
);
