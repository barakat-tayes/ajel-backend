ALTER TABLE orders
ADD COLUMN collected_delivery_fee DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER delivery_fee;
