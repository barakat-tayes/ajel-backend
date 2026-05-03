ALTER TABLE restaurants
ADD COLUMN due_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN last_settlement_at DATETIME NULL,
ADD COLUMN suspension_warning_at DATETIME NULL,
ADD COLUMN last_payment_reminder_at DATETIME NULL;

