ALTER TABLE restaurants
ADD COLUMN location_lat DECIMAL(10,7) NULL AFTER province,
ADD COLUMN location_lng DECIMAL(10,7) NULL AFTER location_lat,
ADD COLUMN location_link VARCHAR(255) NULL AFTER location_lng;

